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

const Kind = { Event: 0, GuardFalse: 1, GuardTrue: 2, Action: 3, Transition: 4, Dropped: 5, Post: 6, TimerSchedule: 7, TimerCancel: 8 };
const Senders = { 0xFF: 'ISR', 0xFE: 'timer', 0xFD: 'PC', 0xFC: 'task' };

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
function createDecoder(dictionaries, out) {
    let encoded = [];
    let actors = [];                  // index -> { name, dict }
    let hz = 1;
    let lastRaw = null, high = 0, origin = null;
    let expectedSequence = null;
    let helloSeen = false, skippedBeforeHello = 0;
    const pending = new Map();        // target actor -> [{ id, sender, t }] posts waiting for their EVENT
    const stats = { frames: 0, badFrames: 0, records: 0, lostRecords: 0, lostFrames: 0 };

    const actorName = i => (actors[i] ? actors[i].name : (Senders[i] || `actor${i}`));
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
    const line = (t, who, text) => out(`${ms(t)}  ${who.padEnd(10)} ${text}`);

    let lastHello = null;   // the HELLO body last applied, to recognise the target's periodic repeats

    function onHello(body) {
        const key = Buffer.from(body).toString('hex');
        if (key === lastHello) {
            return;   // periodic repeat of the HELLO already applied: keep timestamps continuous
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
                out(`warning: no dictionary for actor '${name}' (model hash 0x${hash.toString(16).padStart(8, '0')}): ` +
                    `pass the folder with its <machine>_trace.json to --dict`);
            } else if (!byHash) {
                out(`warning: '${name}' firmware was built from a different model than its dictionary ` +
                    `(target 0x${hash.toString(16).padStart(8, '0')}, dictionary ${dict.model_hash}) - re-export and rebuild`);
            }
        }
        helloSeen = true;
        lastRaw = null; high = 0; origin = null; expectedSequence = null; pending.clear();
        if (skippedBeforeHello > 0) {
            out(`--- ${skippedBeforeHello} record(s) received before the first HELLO were skipped ---`);
            skippedBeforeHello = 0;
        }
        out(`--- HELLO: protocol ${version}, clock ${hz} Hz, actors: ${actors.map((a, i) => `${i}=${a.name}`).join(', ')}`);
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
                line(t, actorName(actor), `[EVENT] ${eventName(actor, id)}${note}`);
                break;
            }
            case Kind.GuardFalse:
            case Kind.GuardTrue:
                line(t, actorName(actor), `[GUARD] ${descriptor(actor, 'guards', id)} -> ${kind === Kind.GuardTrue ? 'PASSED' : 'FAILED'}`);
                break;
            case Kind.Action:
                line(t, actorName(actor), `[ACTION] ${descriptor(actor, 'actions', id)}`);
                break;
            case Kind.Transition:
                line(t, actorName(actor), `[TRANSITION] ${stateName(actor, id >> 8)} ===> ${stateName(actor, id & 0xFF)}`);
                break;
            case Kind.Post: {
                if (!pending.has(target)) pending.set(target, []);
                pending.get(target).push({ id, sender: actor, t });
                line(t, actorName(actor), `[POST] ${eventName(target, index)} -> ${actorName(target)}`);
                break;
            }
            case Kind.Dropped: {
                const queue = pending.get(target) || [];
                const i = queue.map(p => p.id).lastIndexOf(id);
                if (i >= 0) queue.splice(i, 1);
                line(t, actorName(actor), `[DROPPED] ${eventName(target, index)} -> ${actorName(target)} (queue full)`);
                break;
            }
            case Kind.TimerSchedule:
                line(t, actorName(actor), `[SCHEDULE] ${eventName(target, index)} -> ${actorName(target)}`);
                break;
            case Kind.TimerCancel:
                line(t, actorName(actor), `[CANCEL] ${eventName(target, index)} -> ${actorName(target)}`);
                break;
            default:
                line(t, actorName(actor), `[KIND ${kind}] id=${id}`);
        }
    }

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
            if (expectedSequence !== null && sequence !== expectedSequence) {
                const missing = (sequence - expectedSequence + 256) % 256;
                stats.lostFrames += missing;
                out(`--- ${missing} frame(s) lost in transport ---`);
            }
            expectedSequence = (sequence + 1) % 256;
            for (let p = 1; p + 8 <= body.length; p += 8) {
                const raw = (body[p] | (body[p + 1] << 8) | (body[p + 2] << 16) | (body[p + 3] * 0x1000000)) >>> 0;
                onRecord(raw, body[p + 4], body[p + 5], body[p + 6] | (body[p + 7] << 8));
            }
        } else if (type === 0x03) {
            const n = (body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] * 0x1000000)) >>> 0;
            stats.lostRecords += n;
            out(`--- ${n} trace record(s) lost on the target (buffer full) ---`);
        } else {
            out(`--- frame type 0x${type.toString(16)} (${body.length} bytes) ---`);
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

    return { feed, stats };
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
        return;
    }
    if (process.platform === 'win32') {
        console.error('Serial ports on Windows need the serialport package: npm install serialport');
        process.exit(1);
    }
    // Linux/macOS fallback: configure the device with stty, then read it as a file
    const flag = process.platform === 'darwin' ? '-f' : '-F';
    execFileSync('stty', [flag, port, String(baud), 'raw', '-echo', 'cs8', '-cstopb', '-parenb']);
    const stream = fs.createReadStream(port);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', e => { console.error(`serial: ${e.message}`); process.exit(1); });
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
        else { console.error(`unknown argument: ${a}`); process.exit(2); }
    }
    if (!args.serial && !args.tcp && !args.file) {
        console.error('usage: fa-trace --dict <folder|*_trace.json> (--serial <port> [--baud n] | --tcp host:port | --file <path|->)');
        process.exit(2);
    }
    if (args.dicts.length === 0) args.dicts.push('.');

    const decoder = createDecoder(loadDictionaries(args.dicts), l => console.log(l));
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
    } else {
        openSerial(args.serial, args.baud, onData, onEnd);
    }
}

module.exports = { createDecoder, loadDictionaries, crc16, cobsDecode };

if (require.main === module) {
    main(process.argv.slice(2));
}
