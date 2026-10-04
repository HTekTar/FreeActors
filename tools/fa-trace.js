#!/usr/bin/env node
// ==========================================================================
// fa-trace — FreeActors trace decoder (docs/design/trace.md, section 6)
//
//   node tools/fa-trace.js --dict <folder or *_trace.json> <source>
//   sources:
//     --serial <port> [--baud 115200]   e.g. /dev/ttyACM0 or COM3 (uses the `serialport` package if installed;
//                                       on Linux/macOS it falls back to stty + the device file)
//     --tcp <host:port>                 e.g. localhost:9090 (OpenOCD RTT server, serial-to-network bridges)
//     --file <path>                     a recorded trace; "-" reads stdin
//   --color / --no-color                colors are on for a terminal (off for files and pipes, or with NO_COLOR)
//
// Commands (targets built with FA_TRACE_COMMANDS; section 3): with --serial or --tcp, type commands while the
// trace runs (`help` lists them); replies (ACK, STATES) appear in the trace. Scripted, without a target:
//     node tools/fa-trace.js --dict <folder> --actors Timebomb,Counter --encode "post Timebomb ButtonPressed" > cmds.bin
// (--actors: the application's actors in order, as HELLO would name them; --encode may be repeated)
//
// Prints one line per trace record, in the simulator's style:
//      12.503 ms  Timebomb   [TRANSITION] LEDON ===> LEDOFF
// Each EVENT is paired with the POST that queued it: sender and time spent in the queue.
// ==========================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

// ---- Framing (fa_frame.hpp) ------------------------------------------------------------------------------

function crc16(bytes) {
    let crc = 0xFFFF;
    for (const b of bytes) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
        }
    }
    return crc;
}

function cobsEncode(input) {
    const out = [0];
    let codeAt = 0, code = 1;
    for (const b of input) {
        if (b === 0) {
            out[codeAt] = code; codeAt = out.length; out.push(0); code = 1;
        } else {
            out.push(b); code++;
            if (code === 0xFF) { out[codeAt] = code; codeAt = out.length; out.push(0); code = 1; }
        }
    }
    out[codeAt] = code;
    return out;
}

// A complete frame for the wire: COBS(type, body, CRC-16 little-endian) followed by 0x00
function encodeFrame(type, body) {
    const raw = [type, ...body];
    const crc = crc16(raw);
    raw.push(crc & 0xFF, crc >> 8);
    return Buffer.from([...cobsEncode(raw), 0]);
}

function cobsDecode(input) {
    const out = [];
    let i = 0;
    while (i < input.length) {
        const code = input[i++];
        if (code === 0) return null;
        for (let k = 1; k < code; k++) {
            if (i >= input.length) return null;
            out.push(input[i++]);
        }
        if (code !== 0xFF && i < input.length) out.push(0);
    }
    return out;
}

// ---- Decoder ---------------------------------------------------------------------------------------------

const Kind = { Event: 0, GuardFalse: 1, GuardTrue: 2, Action: 3, Transition: 4, Dropped: 5, Post: 6, TimerSchedule: 7, TimerCancel: 8,
               HealthFault: 9, HealthReset: 10 };
const Senders = { 0xFF: 'ISR', 0xFE: 'timer', 0xFD: 'PC', 0xFC: 'task', 0xFB: 'health' };
const ResetCause = ['unknown', 'power-on', 'reset pin', 'software reset', 'watchdog', 'brown-out', 'low-power', 'other'];
const HealthStatus = ['ok', 'STUCK', 'NO PROGRESS', 'IDLE', 'PAUSED', 'STORM', 'UNEXPECTED IRQ'];
const CommandStatus = ['ok', 'unknown actor', 'unknown event', 'payload size mismatch', 'queue full', 'not supported', 'bad frame',
                       'not allowed'];

function loadDictionaries(paths) {
    const byMachine = new Map();
    for (const p of paths) {
        const files = fs.statSync(p).isDirectory()
            ? fs.readdirSync(p).filter(f => f.endsWith('_trace.json')).map(f => path.join(p, f))
            : [p];
        for (const f of files) {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.format !== 'freeactors-trace-dictionary') continue;
            byMachine.set(d.machine, d);
        }
    }
    return byMachine;
}

// Returns { feed(bytes), stats }. Calls out(line) for every decoded line.
// ANSI colors for a terminal; every function returns its text unchanged when colors are off
function palette(enabled) {
    const sgr = code => (enabled ? s => (s ? `\x1b[${code}m${s}\x1b[0m` : s) : s => s);
    // Actor names: 256-color hues apart from the record colors (sky, lavender, orange, teal, pink, lime)
    const actorColors = ['38;5;75', '38;5;141', '38;5;214', '38;5;79', '38;5;204', '38;5;149'].map(sgr);
    return {
        dim: sgr('2'), bold: sgr('1'), red: sgr('31'), boldRed: sgr('1;31'), green: sgr('32'),
        yellow: sgr('33'), boldYellow: sgr('1;33'), cyan: sgr('36'), magenta: sgr('35'),
        actor: i => actorColors[i % actorColors.length],
    };
}

// options.color: ANSI colors (the CLI enables them for a terminal)
function createDecoder(dictionaries, out, options = {}) {
    const c = palette(options.color === true);
    let encoded = [];
    let actors = [];                  // index -> { name, dict }
    let modules = [];                 // health monitor task index -> name (MODULES frame)
    let interrupts = [];              // interrupt module n -> { irq, name } (INTERRUPTS frame); sender 0xC0 + n
    let hz = 1;
    let lastRaw = null, high = 0, origin = null;
    let expectedSequence = null;
    let helloSeen = false, skippedBeforeHello = 0;
    let helloSinceRecords = false;    // a HELLO arrived since the last RECORDS frame (restart detection)
    const pending = new Map();        // target actor -> [{ id, sender, t }] posts waiting for their EVENT
    const stats = { frames: 0, badFrames: 0, records: 0, lostRecords: 0, lostFrames: 0 };

    const interruptName = n => (interrupts[n] ? (interrupts[n].name || `irq${interrupts[n].irq}`) : `isr${n}`);
    const actorName = i => (actors[i] ? actors[i].name : i >= 0xC0 && i < 0xE0 ? interruptName(i - 0xC0) : (Senders[i] || `actor${i}`));
    const dictOf = i => (actors[i] ? actors[i].dict : undefined);
    const eventName = (actor, index) => { const d = dictOf(actor); return (d && d.events[index]) || `event#${index}`; };
    const stateName = (actor, index) => { const d = dictOf(actor); return (d && d.states[index]) || `state#${index}`; };
    const descriptor = (actor, table, id) => { const d = dictOf(actor); return (d && d[table][String(id)]) || `#${id}`; };

    function time(raw) {
        if (lastRaw !== null && raw < lastRaw) high += 0x100000000;   // 32-bit wrap
        lastRaw = raw;
        const t = (high + raw) / hz;
        if (origin === null) origin = t;
        return t - origin;
    }
    const ms = t => (t * 1000).toFixed(3).padStart(11) + ' ms';
    const us = t => (t * 1e6 < 1000 ? `${(t * 1e6).toFixed(1)} µs` : `${(t * 1000).toFixed(3)} ms`);
    // who: actor index or sender id; the name is padded before coloring so columns stay aligned
    const line = (t, who, text) => {
        const name = actorName(who).padEnd(10);
        out(`${c.dim(ms(t))}  ${actors[who] ? c.actor(who)(name) : c.dim(name)} ${text}`);
    };

    let lastHello = null;   // the HELLO body last applied, to recognise the target's periodic repeats

    function onHello(body) {
        const key = Buffer.from(body).toString('hex');
        helloSinceRecords = true;
        if (key === lastHello) {
            return;   // periodic repeat or a restart of the same firmware: told apart at the next RECORDS frame
        }
        lastHello = key;

        const version = body[0];
        hz = body[1] | (body[2] << 8) | (body[3] << 16) | (body[4] * 0x1000000);
        const count = body[5];
        actors = [];
        let p = 6;
        for (let i = 0; i < count && p < body.length; i++) {
            const n = body[p++];
            const name = Buffer.from(body.slice(p, p + n)).toString('ascii'); p += n;
            const hash = (body[p] | (body[p + 1] << 8) | (body[p + 2] << 16) | (body[p + 3] * 0x1000000)) >>> 0; p += 4;
            // Match by model hash (identifies the model, whatever the task is called), then by machine name
            const byHash = [...dictionaries.values()].find(d => parseInt(d.model_hash, 16) === hash);
            const byName = dictionaries.get(name);
            const dict = byHash || byName;
            actors.push({ name, dict });
            if (!dict) {
                out(c.yellow(`warning: no dictionary for actor '${name}' (model hash 0x${hash.toString(16).padStart(8, '0')}): ` +
                    `pass the folder with its <machine>_trace.json to --dict`));
            } else if (!byHash) {
                out(c.yellow(`warning: '${name}' firmware was built from a different model than its dictionary ` +
                    `(target 0x${hash.toString(16).padStart(8, '0')}, dictionary ${dict.model_hash}) - re-export and rebuild`));
            }
        }
        helloSeen = true;
        lastRaw = null; high = 0; origin = null; expectedSequence = null; pending.clear();
        if (skippedBeforeHello > 0) {
            out(c.dim(`--- ${skippedBeforeHello} record(s) received before the first HELLO were skipped ---`));
            skippedBeforeHello = 0;
        }
        out(c.bold(`--- HELLO: protocol ${version}, clock ${hz} Hz, actors: `) +
            actors.map((a, i) => c.actor(i)(`${i}=${a.name}`)).join(c.bold(', ')));
    }

    const moduleName = i => (i >= 0xC0 && i < 0xE0 ? interruptName(i - 0xC0) : i === 0xFF ? 'interrupt' :
                             modules[i] || (actors[i] ? actors[i].name : `task${i}`));

    function healthFault(t, task, id) {
        const ms = id & 0x0FFF;
        const time = ms >= 4095 ? 'over 4 s' : `${ms} ms`;
        const what = [null, `stuck: busy ${time} in one step`, `no progress for ${time} with work waiting`,
                      `idle: no input for ${time}`, null,
                      `interrupt storm: ${ms >= 4095 ? 'over 4095' : ms} calls in one tick, interrupt disabled`,
                      `unexpected interrupt ${ms}: not in the vector table, disabled`][(id >> 12) & 7] || `fault ${(id >> 12) & 7}`;
        const previous = (id & 0x8000) !== 0;
        line(t, 0xFB, c.boldRed(`[HEALTH] ${task === 0xFF ? '' : moduleName(task) + ' '}${what}`) +
                      (previous ? c.dim('   (previous run: caused the reset)') : c.dim('   (watchdog no longer fed)')));
    }

    function onRecord(raw, kind, actor, id) {
        stats.records++;
        const t = time(raw);
        const target = id >> 8, index = id & 0xFF;
        switch (kind) {
            case Kind.Event: {
                const queue = pending.get(actor) || [];
                let note = '';
                if (queue.length > 0 && (queue[0].id & 0xFF) === id) {
                    const post = queue.shift();
                    note = `   (from ${actorName(post.sender)}, ${us(t - post.t)} in queue)`;
                }
                line(t, actor, `${c.cyan(`[EVENT] ${eventName(actor, id)}`)}${c.dim(note)}`);
                break;
            }
            case Kind.GuardFalse:
            case Kind.GuardTrue:
                line(t, actor, `[GUARD] ${descriptor(actor, 'guards', id)} -> ${kind === Kind.GuardTrue ? c.green('PASSED') : c.red('FAILED')}`);
                break;
            case Kind.Action:
                line(t, actor, `[ACTION] ${descriptor(actor, 'actions', id)}`);
                break;
            case Kind.Transition:
                line(t, actor, c.boldYellow(`[TRANSITION] ${stateName(actor, id >> 8)} ===> ${stateName(actor, id & 0xFF)}`));
                break;
            case Kind.Post: {
                if (!pending.has(target)) pending.set(target, []);
                pending.get(target).push({ id, sender: actor, t });
                line(t, actor, c.magenta(`[POST] ${eventName(target, index)} -> ${actorName(target)}`));
                break;
            }
            case Kind.Dropped: {
                const queue = pending.get(target) || [];
                const i = queue.map(p => p.id).lastIndexOf(id);
                if (i >= 0) queue.splice(i, 1);
                line(t, actor, c.boldRed(`[DROPPED] ${eventName(target, index)} -> ${actorName(target)} (queue full)`));
                break;
            }
            case Kind.TimerSchedule:
                line(t, actor, c.dim(`[SCHEDULE] ${eventName(target, index)} -> ${actorName(target)}`));
                break;
            case Kind.HealthFault:
                healthFault(t, actor, id);
                break;
            case Kind.HealthReset:
                line(t, 0xFB, c.bold(`[RESET] started after: ${ResetCause[id] || `cause ${id}`}`));
                break;
            case Kind.TimerCancel:
                line(t, actor, c.dim(`[CANCEL] ${eventName(target, index)} -> ${actorName(target)}`));
                break;
            default:
                line(t, actor, `[KIND ${kind}] id=${id}`);
        }
    }

    const commands = new Map();       // command sequence -> command text, to label its ACK

    function onFrame(type, body) {
        stats.frames++;
        if (type === 0x01) {
            onHello(body);
        } else if (type === 0x02) {
            if (!helloSeen) {
                skippedBeforeHello += Math.floor((body.length - 1) / 8);
                return;
            }
            const sequence = body[0];
            // The target restarted: HELLO, then the frame counter starting again at 0 out of turn (a periodic
            // HELLO comes exactly when the counter wraps to 0, a requested one leaves the counter alone)
            if (helloSinceRecords && sequence === 0 && expectedSequence !== null && expectedSequence !== 0) {
                out(c.bold('--- target restarted ---'));
                lastRaw = null; high = 0; origin = null; expectedSequence = null; pending.clear();
            }
            helloSinceRecords = false;
            if (expectedSequence !== null && sequence !== expectedSequence) {
                const missing = (sequence - expectedSequence + 256) % 256;
                stats.lostFrames += missing;
                out(c.red(`--- ${missing} frame(s) lost in transport ---`));
            }
            expectedSequence = (sequence + 1) % 256;
            for (let p = 1; p + 8 <= body.length; p += 8) {
                const raw = (body[p] | (body[p + 1] << 8) | (body[p + 2] << 16) | (body[p + 3] * 0x1000000)) >>> 0;
                onRecord(raw, body[p + 4], body[p + 5], body[p + 6] | (body[p + 7] << 8));
            }
        } else if (type === 0x03) {
            const n = (body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] * 0x1000000)) >>> 0;
            stats.lostRecords += n;
            out(c.red(`--- ${n} trace record(s) lost on the target (buffer full) ---`));
        } else if (type === 0x04) {
            // STATES (reply to QUERY_STATES): sequence, actor count, u16 state per actor
            const states = [];
            for (let a = 0; a < body[1] && 3 + 2 * a < body.length; a++) {
                states.push(`${actorName(a)}=${stateName(a, body[2 + 2 * a] | (body[3 + 2 * a] << 8))}`);
            }
            out(c.cyan(`--- STATES #${body[0]}: ${states.join(', ')}`));
            commands.delete(body[0]);
        } else if (type === 0x06) {
            // MODULES: names of the tasks the health monitor watches (sent after HELLO)
            const names = [];
            for (let p = 1, i = 0; i < body[0] && p < body.length; i++) {
                const n = body[p++];
                names.push(Buffer.from(body.slice(p, p + n)).toString('ascii'));
                p += n;
            }
            const changed = names.join(',') !== modules.join(',');
            modules = names;
            if (changed) out(c.dim(`--- health monitor watches: ${names.map((n, i) => `${i}=${n}`).join(', ')}`));
        } else if (type === 0x08) {
            // INTERRUPTS: interrupt module n is trace sender 0xC0 + n
            const list = [];
            for (let p = 1, i = 0; i < body[0] && p + 2 <= body.length; i++) {
                const irq = body[p++], n = body[p++];
                list.push({ irq, name: Buffer.from(body.slice(p, p + n)).toString('ascii') });
                p += n;
            }
            const changed = JSON.stringify(list) !== JSON.stringify(interrupts);
            interrupts = list;
            if (changed) out(c.dim(`--- interrupt modules: ${list.map((x, i) => `${interruptName(i)} (IRQ ${x.irq})`).join(', ')}`));
        } else if (type === 0x07) {
            // HEALTH (reply to QUERY_HEALTH): see docs/design/health.md
            const uptime = (body[3] | (body[4] << 8) | (body[5] << 16) | (body[6] * 0x1000000)) >>> 0;
            const failed = body[2] !== 0;
            out(c.cyan(`--- HEALTH #${body[0]}: started after ${ResetCause[body[1]] || body[1]}, up ${(uptime / 1000).toFixed(1)} s, `) +
                (failed ? c.boldRed('watchdog no longer fed (fault)') : c.green('watchdog fed')));
            out(c.dim(`    ${'task'.padEnd(16)}${'status'.padEnd(13)}${'longest step'.padEnd(14)}free stack`));
            for (let i = 0, p = 8; i < body[7] && p + 5 <= body.length; i++, p += 5) {
                const status = HealthStatus[body[p]] || `fault ${body[p]}`;
                const step = body[p + 1] | (body[p + 2] << 8);
                const stack = body[p + 3] | (body[p + 4] << 8);
                const statusText = status.padEnd(13);
                const colored = body[p] === 0 ? c.green(statusText) : body[p] === 4 ? c.yellow(statusText) : c.boldRed(statusText);
                out(`    ${moduleName(i).padEnd(16)}${colored}` +
                    `${(step + ' ms').padEnd(14)}${stack === 0xFFFF ? 'n/a' : stack + ' words'}`);
            }
            commands.delete(body[0]);
        } else if (type === 0x05) {
            // ACK (reply to a command): sequence, status
            const command = commands.get(body[0]);
            commands.delete(body[0]);
            const text = `--- ACK #${body[0]}: ${CommandStatus[body[1]] || `status ${body[1]}`}`;
            out(`${body[1] === 0 ? c.green(text) : c.red(text)}${c.dim(command ? `   (${command})` : '')}`);
        } else {
            out(c.dim(`--- frame type 0x${type.toString(16)} (${body.length} bytes) ---`));
        }
    }

    function feed(bytes) {
        for (const b of bytes) {
            if (b !== 0) {
                if (encoded.length < 300) encoded.push(b);
                continue;
            }
            if (encoded.length > 0) {
                const raw = cobsDecode(encoded);
                if (raw && raw.length >= 3 &&
                    crc16(raw.slice(0, raw.length - 2)) === (raw[raw.length - 2] | (raw[raw.length - 1] << 8))) {
                    onFrame(raw[0], raw.slice(1, raw.length - 2));
                } else {
                    stats.badFrames++;
                }
            }
            encoded = [];
        }
    }

    return {
        feed, stats,
        actors: () => actors,
        tasks: () => (modules.length > 0 ? modules : actors.map(a => a.name)),
        sent: (sequence, text) => commands.set(sequence, text),
    };
}

// ---- Commands (PC -> target, trace.md section 4.3) ------------------------------------------------------

const Command = { Post: 0x81, QueryStates: 0x82, Reset: 0x83, HelloRequest: 0x84, Filter: 0x85, QueryHealth: 0x86,
                  Pause: 0x87, Resume: 0x88, HealthTest: 0x89 };
const KindNames = { event: 0, guard: [1, 2], action: 3, transition: 4, dropped: 5, post: 6, timer: [7, 8], health: [9, 10] };

const COMMAND_HELP = [
    'post <actor> <event> [field=value ...]                    queue an event, e.g. post Sensor Temperature celsius=21',
    '                                                          (values by position work too; arrays 1,2,3; events fa-trace',
    '                                                          cannot read take payload bytes in hex)',
    'states                                                    every actor\'s current state',
    'filter all | filter <kinds> [actors]                      trace only these, e.g. filter transition,event Timebomb',
    '       kinds: event guard action transition dropped post timer health (or a number mask); actors: names or a mask',
    'events [actor]                                            the events each actor accepts (Tab completes names too)',
    'health                                                    every task: status, longest step, free stack (FA_HEALTH)',
    'pause <task> | resume <task>                              stop / restart a task between steps (FA_DEBUG_COMMANDS)',
    'health test <task>                                        pause a task as a fault: the watchdog resets the target',
    'hello                                                     ask for HELLO (actor names, clock)',
    'reset                                                     reset the target (if its board supports it)',
].join('\n');

// ---- Event payloads: encoded from the field layouts in the dictionary (generator: parseEventLayouts) ----

const FieldTypes = {
    bool: { size: 1, put: (v, o, x) => v.setUint8(o, x ? 1 : 0) },
    int8_t: { size: 1, min: -128, max: 127, put: (v, o, x) => v.setInt8(o, x) },
    uint8_t: { size: 1, min: 0, max: 255, put: (v, o, x) => v.setUint8(o, x) },
    int16_t: { size: 2, min: -32768, max: 32767, put: (v, o, x) => v.setInt16(o, x, true) },
    uint16_t: { size: 2, min: 0, max: 65535, put: (v, o, x) => v.setUint16(o, x, true) },
    int32_t: { size: 4, min: -2147483648, max: 2147483647, put: (v, o, x) => v.setInt32(o, x, true) },
    uint32_t: { size: 4, min: 0, max: 4294967295, put: (v, o, x) => v.setUint32(o, x, true) },
    float: { size: 4, put: (v, o, x) => v.setFloat32(o, x, true) },
};

// The layout of an event of an actor's dictionary: { size, fields } if known, null if not understood,
// undefined for dictionaries from before payload layouts
function payloadLayout(actor, eventIndex) {
    const dict = actor && actor.dict;
    if (!dict || dict.payloads === undefined) return undefined;
    const layout = dict.payloads[dict.events[eventIndex]];
    return layout === undefined ? undefined : layout;
}

function parseScalar(type, text) {
    const t = FieldTypes[type];
    if (type === 'bool') {
        if (/^(true|1)$/i.test(text)) return { value: true };
        if (/^(false|0)$/i.test(text)) return { value: false };
        return { error: `'${text}' is not a bool (true/false)` };
    }
    const value = type === 'float' ? Number(text) : (/^-?(0x[0-9a-f]+|\d+)$/i.test(text) ? Number(text) : NaN);
    if (!Number.isFinite(value)) return { error: `'${text}' is not a ${type}` };
    if (t.min !== undefined && (value < t.min || value > t.max)) return { error: `${text} is out of range for ${type} (${t.min}..${t.max})` };
    return { value };
}

// Field values from 'name=value' or positional arguments (arrays: 1,2,3; missing elements and fields stay 0)
function encodePayload(layout, args) {
    const bytes = new Uint8Array(layout.size);
    const view = new DataView(bytes.buffer);
    const given = new Map();
    let position = 0;
    for (const arg of args) {
        const named = /^([A-Za-z_]\w*)=(.*)$/.exec(arg);
        const field = named ? layout.fields.find(f => f.name === named[1]) : layout.fields[position++];
        if (!field) {
            return { error: named ? `no field '${named[1]}' (fields: ${layout.fields.map(f => f.name).join(', ') || 'none'})`
                                  : `too many values (fields: ${layout.fields.map(f => f.name).join(', ') || 'none'})` };
        }
        given.set(field.name, named ? named[2] : arg);
    }
    for (const field of layout.fields) {
        if (!given.has(field.name)) continue;
        const items = given.get(field.name).split(',').filter(s => s.length > 0);
        if (items.length > field.count) return { error: `${field.name} holds ${field.count} value(s), got ${items.length}` };
        const size = FieldTypes[field.type].size;
        for (let i = 0; i < items.length; i++) {
            const parsed = parseScalar(field.type, items[i]);
            if (parsed.error) return { error: `${field.name}: ${parsed.error}` };
            FieldTypes[field.type].put(view, field.offset + i * size, parsed.value);
        }
    }
    return { bytes: [...bytes] };
}

const describeFields = layout => layout.fields.map(f => `${f.name}:${f.type}${f.count > 1 ? `[${f.count}]` : ''}`).join(' ');

// Builds a command frame from a line of text. actors(): [{ name, dict }] from HELLO or --actors;
// tasks(): task names from MODULES (health monitor / pause commands), if any.
// Returns { frame, sequence, text } or { error }. sequence is undefined for commands that get no ACK.
function createCommander(actors, tasks = () => actors().map(a => a.name)) {
    let sequence = 0;
    const next = () => { sequence = (sequence + 1) & 0xFF; return sequence; };

    const number = s => (/^(0x[0-9a-f]+|\d+)$/i.test(s) ? Number(s) : undefined);
    const findActor = s => {
        const list = actors();
        const n = number(s);
        if (n !== undefined) return n < list.length ? n : { error: `no actor ${n} (${list.length} actors)` };
        const i = list.findIndex(a => a.name === s || (a.dict && a.dict.machine === s));
        if (i >= 0) return i;
        return { error: list.length === 0 ? 'actor names unknown until HELLO arrives (try: hello)'
                                           : `no actor '${s}' (actors: ${list.map(a => a.name).join(', ')})` };
    };
    const findEvent = (actor, s) => {
        const n = number(s);
        if (n !== undefined) return n;
        const dict = actors()[actor].dict;
        const i = dict ? dict.events.indexOf(s) : -1;
        return i >= 0 ? i : { error: dict ? `no event '${s}' in ${dict.machine} (events: ${dict.events.filter(e => !e.endsWith('_sig')).join(', ')})`
                                          : `no dictionary for ${actors()[actor].name}: give the event number` };
    };

    const findTask = s => {
        const list = tasks();
        const n = number(s);
        if (n !== undefined) return n;
        const i = list.indexOf(s);
        if (i >= 0) return i;
        return { error: list.length === 0 ? 'task names unknown until HELLO arrives (try: hello)'
                                           : `no task '${s}' (tasks: ${list.join(', ')})` };
    };
    const taskCommand = (type, name, text) => {
        if (name === undefined) return { error: 'which task? (names as listed by: health)' };
        const task = findTask(name);
        if (typeof task !== 'number') return task;
        const seq = next();
        return { frame: encodeFrame(type, [seq, task]), sequence: seq, text };
    };

    return function build(line) {
        const words = line.trim().split(/\s+/).filter(w => w.length > 0);
        const text = words.join(' ');
        switch (words[0]) {
            case 'post': {
                if (words.length < 3) return { error: 'usage: post <actor> <event> [field=value ...]' };
                const actor = findActor(words[1]);
                if (typeof actor !== 'number') return actor;
                const event = findEvent(actor, words[2]);
                if (typeof event !== 'number') return event;
                const layout = payloadLayout(actors()[actor], event);
                let payload;
                if (layout) {                                   // fields known: values by name or position
                    const encoded = encodePayload(layout, words.slice(3));
                    if (encoded.error) return { error: `${words[2]}: ${encoded.error}` };
                    payload = encoded.bytes;
                } else {                                        // layout not understood: raw bytes in hex
                    payload = words.slice(3).map(b => parseInt(b, 16));
                    if (payload.some(b => !(b >= 0 && b <= 0xFF))) {
                        return { error: `${words[2]}: its fields are not known to fa-trace; give the payload as bytes in hex, e.g. 01 ff` };
                    }
                }
                const seq = next();
                return { frame: encodeFrame(Command.Post, [seq, actor, event, ...payload]), sequence: seq, text };
            }
            case 'states': {
                const seq = next();
                return { frame: encodeFrame(Command.QueryStates, [seq]), sequence: seq, text };
            }
            case 'pause':
                return taskCommand(Command.Pause, words[1], text);
            case 'resume':
                return taskCommand(Command.Resume, words[1], text);
            case 'health': {
                if (words[1] === 'test') return taskCommand(Command.HealthTest, words[2], text);
                const seq = next();
                return { frame: encodeFrame(Command.QueryHealth, [seq]), sequence: seq, text };
            }
            case 'reset': {
                const seq = next();
                return { frame: encodeFrame(Command.Reset, [seq]), sequence: seq, text };
            }
            case 'hello':
                return { frame: encodeFrame(Command.HelloRequest, []), text };
            case 'filter': {
                let kinds = 0xFFFF, actorMask = 0xFFFFFFFF;
                if (words[1] !== 'all') {
                    if (words.length < 2) return { error: 'usage: filter all | filter <kinds> [actors]' };
                    kinds = number(words[1]);
                    if (kinds === undefined) {
                        kinds = 0;
                        for (const k of words[1].split(',')) {
                            if (!(k in KindNames)) return { error: `unknown kind '${k}' (kinds: ${Object.keys(KindNames).join(' ')})` };
                            for (const bit of [].concat(KindNames[k])) kinds |= 1 << bit;
                        }
                    }
                    if (words[2] !== undefined) {
                        actorMask = number(words[2]);
                        if (actorMask === undefined) {
                            actorMask = 0;
                            for (const a of words[2].split(',')) {
                                const i = findActor(a);
                                if (typeof i !== 'number') return i;
                                actorMask |= 1 << i;
                            }
                        }
                    }
                }
                const seq = next();
                const body = [seq, kinds & 0xFF, (kinds >> 8) & 0xFF,
                              actorMask & 0xFF, (actorMask >>> 8) & 0xFF, (actorMask >>> 16) & 0xFF, (actorMask >>> 24) & 0xFF];
                return { frame: encodeFrame(Command.Filter, body), sequence: seq, text };
            }
            default:
                return { error: `unknown command '${words[0]}'\n${COMMAND_HELP}` };
        }
    };
}

// ---- Sources and CLI -------------------------------------------------------------------------------------

function openSerial(port, baud, onData, onEnd) {
    let SerialPort;
    try {
        ({ SerialPort } = require('serialport'));
    } catch (e) {
        SerialPort = null;
    }
    if (SerialPort) {
        const serial = new SerialPort({ path: port, baudRate: baud });
        serial.on('data', onData);
        serial.on('close', onEnd);
        serial.on('error', e => { console.error(`serial: ${e.message}`); process.exit(1); });
        return frame => serial.write(frame);
    }
    if (process.platform === 'win32') {
        console.error('Serial ports on Windows need the serialport package: npm install serialport');
        process.exit(1);
    }
    // Linux/macOS fallback: configure the device with stty, then read it as a file
    if (!fs.existsSync(port)) {
        console.error(`serial: ${port} does not exist - is the board connected? (list ports: ls /dev/tty{ACM,USB}* on Linux, ls /dev/cu.* on macOS)`);
        process.exit(1);
    }
    const flag = process.platform === 'darwin' ? '-f' : '-F';
    try {
        execFileSync('stty', [flag, port, String(baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb'], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
        console.error(`serial: cannot configure ${port}: ${String(e.stderr || e.message).trim()}`);
        process.exit(1);
    }
    // A tty stream (non-blocking), not fs.createReadStream: a blocking read in Node's thread pool would keep
    // the process from exiting on Ctrl+C
    const fd = fs.openSync(port, 'r+');
    const stream = new (require('tty').ReadStream)(fd);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', e => { console.error(`serial: ${e.message}`); process.exit(1); });
    return frame => {
        try {
            fs.writeSync(fd, frame);   // command frames are small: a short blocking write
        } catch (e) {
            console.error(`serial: cannot send: ${e.message}`);
        }
    };
}

function main(argv) {
    const args = { dicts: [], baud: 115200 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dict') args.dicts.push(argv[++i]);
        else if (a === '--serial') args.serial = argv[++i];
        else if (a === '--baud') args.baud = Number(argv[++i]);
        else if (a === '--tcp') args.tcp = argv[++i];
        else if (a === '--file') args.file = argv[++i];
        else if (a === '--encode') (args.encode = args.encode || []).push(argv[++i]);
        else if (a === '--actors') args.actors = argv[++i].split(',');
        else if (a === '--color') args.color = true;
        else if (a === '--no-color') args.color = false;
        else { console.error(`unknown argument: ${a}`); process.exit(2); }
    }
    if (args.dicts.length === 0) args.dicts.push('.');
    const dictionaries = loadDictionaries(args.dicts);

    if (args.encode) {
        // Scripted commands: frames to stdout, actors named by --actors (in application order)
        const actors = (args.actors || []).map(name => ({
            name, dict: dictionaries.get(name) || [...dictionaries.values()].find(d => d.machine === name) }));
        const build = createCommander(() => actors);
        for (const line of args.encode) {
            const command = build(line);
            if (command.error) { console.error(`fa-trace: ${line}: ${command.error}`); process.exit(2); }
            process.stdout.write(command.frame);
        }
        return;
    }
    if (!args.serial && !args.tcp && !args.file) {
        console.error('usage: fa-trace --dict <folder|*_trace.json> (--serial <port> [--baud n] | --tcp host:port | --file <path|->)\n' +
                      '       fa-trace --dict <folder|*_trace.json> --actors <name,...> --encode "<command>"...');
        process.exit(2);
    }

    let prompt = null;   // the command line, when commands can be sent
    // Colors for a terminal unless NO_COLOR (no-color.org) or --no-color; --color forces them (e.g. through less -R)
    const color = args.color !== undefined ? args.color : (process.stdout.isTTY === true && !process.env.NO_COLOR);
    const decoder = createDecoder(dictionaries, l => {
        if (prompt) { process.stdout.write('\r\x1b[K'); console.log(l); prompt.prompt(true); } else console.log(l);
    }, { color });
    const onData = chunk => decoder.feed(chunk);
    const onEnd = () => {
        const s = decoder.stats;
        console.error(`fa-trace: ${s.records} records, ${s.frames} frames, ${s.badFrames} bad frames, ` +
                      `${s.lostRecords} records lost on target, ${s.lostFrames} frames lost in transport`);
    };

    if (args.file) {
        const stream = args.file === '-' ? process.stdin : fs.createReadStream(args.file);
        stream.on('data', onData);
        stream.on('end', onEnd);
    } else if (args.tcp) {
        const [host, port] = args.tcp.split(':');
        const socket = net.connect(Number(port), host || 'localhost');
        socket.on('data', onData);
        socket.on('end', onEnd);
        socket.on('error', e => { console.error(`tcp: ${e.message}`); process.exit(1); });
        prompt = startCommandLine(decoder, frame => socket.write(frame));
    } else {
        const write = openSerial(args.serial, args.baud, onData, onEnd);
        prompt = startCommandLine(decoder, write);
    }
}

// Events an actor accepts: its dictionary's events without the reserved signals (Enter_sig, ...)
const postable = actor => (actor.dict ? actor.dict.events.filter(e => !e.endsWith('_sig')) : []);

// "events [actor]": answered locally from HELLO and the dictionaries
function listEvents(actors, which) {
    if (actors.length === 0) return 'actor names unknown until HELLO arrives (try: hello)';
    const chosen = actors.filter((a, i) => which === undefined || a.name === which || String(i) === which ||
                                           (a.dict && a.dict.machine === which));
    if (chosen.length === 0) return `no actor '${which}' (actors: ${actors.map(a => a.name).join(', ')})`;
    const withFields = (a, e) => {
        const layout = payloadLayout(a, a.dict.events.indexOf(e));
        return layout && layout.fields.length > 0 ? `${e}(${describeFields(layout)})` : layout === null ? `${e}(bytes)` : e;
    };
    return chosen.map(a => `${a.name}: ${a.dict ? postable(a).map(e => withFields(a, e)).join(', ') : '(no dictionary: pass its folder to --dict)'}`).join('\n');
}

// Tab completion: command, then actor, then event (filter: kinds, then actors)
function completer(actors, tasks) {
    const commands = ['post', 'states', 'health', 'pause', 'resume', 'filter', 'events', 'hello', 'reset', 'help'];
    return line => {
        const words = line.split(/\s+/);
        const last = words[words.length - 1];
        let options = [];
        if (words.length === 1) options = commands;
        else if (words[0] === 'post' && words.length === 2) options = actors().map(a => a.name);
        else if (words[0] === 'events' && words.length === 2) options = actors().map(a => a.name);
        else if (words[0] === 'post' && words.length === 3) {
            const actor = actors().find((a, i) => a.name === words[1] || String(i) === words[1]);
            options = actor ? postable(actor) : [];
        } else if (words[0] === 'post' && words.length > 3) {             // field names of the event
            const actor = actors().find((a, i) => a.name === words[1] || String(i) === words[1]);
            const index = actor && actor.dict ? actor.dict.events.indexOf(words[2]) : -1;
            const layout = index >= 0 ? payloadLayout(actor, index) : undefined;
            options = layout ? layout.fields.map(f => `${f.name}=`) : [];
        } else if (words[0] === 'filter' && words.length === 2) options = ['all', ...Object.keys(KindNames)];
        else if (words[0] === 'filter' && words.length === 3) options = actors().map(a => a.name);
        else if ((words[0] === 'pause' || words[0] === 'resume') && words.length === 2) options = tasks();
        else if (words[0] === 'health' && words.length === 2) options = ['test'];
        else if (words[0] === 'health' && words[1] === 'test' && words.length === 3) options = tasks();
        const hits = options.filter(o => o.startsWith(last));
        return [(hits.length > 0 ? hits : options).map(o => (o.endsWith('=') ? o : o + ' ')), last];
    };
}

// Reads commands from the keyboard while the trace runs (only when stdin is a terminal)
function startCommandLine(decoder, write) {
    if (!process.stdin.isTTY) return null;
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'fa> ',
                                          completer: completer(decoder.actors, decoder.tasks) });
    const build = createCommander(decoder.actors, decoder.tasks);
    console.log('fa-trace: type commands for the target (help for the list, Ctrl+C to quit)');
    write(build('hello').frame);   // actor names now, not at the target's next periodic HELLO
    rl.on('line', line => {
        if (line.trim() === '') { rl.prompt(); return; }
        if (line.trim() === 'help') { console.log(COMMAND_HELP); rl.prompt(); return; }
        const words = line.trim().split(/\s+/);
        if (words[0] === 'events') { console.log(listEvents(decoder.actors(), words[1])); rl.prompt(); return; }
        const command = build(line);
        if (command.error) {
            console.log(command.error);
        } else {
            if (command.sequence !== undefined) decoder.sent(command.sequence, command.text);
            write(command.frame);
        }
        rl.prompt();
    });
    rl.on('close', () => process.exit(0));
    rl.prompt();
    return rl;
}

module.exports = { createDecoder, createCommander, loadDictionaries, crc16, cobsDecode, cobsEncode, encodeFrame };

if (require.main === module) {
    main(process.argv.slice(2));
}
