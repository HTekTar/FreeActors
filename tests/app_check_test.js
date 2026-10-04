// ==========================================================================
// Application checks (checkAppModel, docs/design/app-diagram.md section 3): the Timebomb application fixture is
// clean; each variation below breaks one rule and must be reported with its message, on the right component or
// connection. Prints PASS/FAIL per check; exits non-zero on any failure.
//   node tests/app_check_test.js
// ==========================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const fixtures = path.join(__dirname, 'fixtures');
const base = JSON.parse(fs.readFileSync(path.join(fixtures, 'timebomb.app.json'), 'utf8'));
const models = fs.readdirSync(fixtures).filter(f => f.endsWith('.hsm.json'))
    .map(f => ext.describeHsmModel(f, fs.readFileSync(path.join(fixtures, f), 'utf8'))).filter(Boolean);

let failures = 0;
const variant = (change) => { const app = JSON.parse(JSON.stringify(base)); change(app); return app; };
const comp = (app, name) => app.components.find(c => c.name === name);

function expect(name, app, text, where, severity = 'error') {
    const problems = ext.checkAppModel(app, models);
    const hit = problems.find(p => p.message.includes(text) && p.severity === severity && (!where || p.component === where || p.connection === where));
    const ok = Boolean(hit);
    console.log(`${ok ? 'PASS' : 'FAIL'}  app check: ${name}${ok ? '' : ` — got ${JSON.stringify(problems.map(p => p.message))}`}`);
    if (!ok) failures++;
}

{
    const problems = ext.checkAppModel(base, models);
    const ok = problems.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  app check: the Timebomb application fixture has no problems${ok ? '' : ` — ${JSON.stringify(problems)}`}`);
    if (!ok) failures++;
}

expect('an event the receiving state machine does not have yet (a warning: Export Application adds it)',
       variant(a => { a.connections[0].events = ['Explode']; }), "has no signal Explode yet", 'L_1', 'warning');
expect('an event name that is not a C++ identifier', variant(a => { a.connections[0].events = ['Explode now']; }),
       '"Explode now" is not a C++ identifier', 'L_1');
expect('events sent to a service instead of an actor', variant(a => { a.connections[0].to = 'C_6'; }),
       'events go to actors', 'L_1');
expect('an actor without a state machine (top-down: a warning, Export Application creates it)',
       variant(a => { delete a.components.find(c => c.id === 'C_2').model; }),
       'Actor Timebomb has no state machine yet: Export Application creates Timebomb.hsm.json', 'C_2', 'warning');
expect('a state machine file that does not exist', variant(a => { a.components.find(c => c.id === 'C_2').model = 'missing.hsm.json'; }),
       'state machine missing.hsm.json not found', 'C_2');
expect('one state machine used by two actors (one instance per machine in v1)', variant(a => {
    a.components.push({ id: 'C_9', kind: 'actor', name: 'Timebomb2', parent: 'APP', model: 'timebomb.hsm.json', x: 0, y: 0 });
}), 'one instance per state machine', 'C_9');
expect('an SPSC service with two producers', variant(a => {
    a.components.push({ id: 'C_9', kind: 'spsc', name: 'Samples', parent: 'APP', item: 'uint16_t', size: 32, x: 0, y: 0 });
    a.connections.push({ id: 'L_8', from: 'C_4', to: 'C_9', kind: 'item', item: 'uint16_t' });
    a.connections.push({ id: 'L_9', from: 'C_5', to: 'C_9', kind: 'item', item: 'uint16_t' });
}), 'has 2 producers', 'C_9');
expect('two services of the same kind for one item type', variant(a => {
    a.components.push({ id: 'C_8', kind: 'mpsc', name: 'LogA', parent: 'APP', item: 'LogLine', size: 8, x: 0, y: 0 });
    a.components.push({ id: 'C_9', kind: 'mpsc', name: 'LogB', parent: 'APP', item: 'LogLine', size: 8, x: 0, y: 0 });
}), 'one service per type', 'C_9');
expect('items of the wrong type pushed to a service', variant(a => {
    a.components.push({ id: 'C_9', kind: 'spsc', name: 'Samples', parent: 'APP', item: 'uint16_t', size: 32, x: 0, y: 0 });
    a.connections.push({ id: 'L_9', from: 'C_4', to: 'C_9', kind: 'item', item: 'float' });
}), 'pushes float, but Samples takes uint16_t', 'L_9');
expect('two interrupt modules on one interrupt', variant(a => { comp(a, 'CommandRxUart').irq = 'command_rx_dma'; }),
       'Irq::command_rx_dma is used by CommandRxDma and CommandRxUart', 'C_5');
expect('an interrupt priority more urgent than FreeRTOS allows', variant(a => { comp(a, 'CommandRxDma').pri = 2; }),
       'more urgent than FreeRTOS allows', 'C_4');
expect('a DMA stream into something that is not a DMA ring', variant(a => { a.connections[1].to = 'C_2'; }),
       'a DMA stream goes to a DMA ring service', 'L_2');
expect('a watchdog timeout below 3 x the health check period', variant(a => { a.settings.WatchdogTimeoutMs = 250; }),
       'must be at least 3 x HealthCheckMs');
expect('debug commands without commands', variant(a => { a.features.commands = false; }),
       'Debug commands (FA_DEBUG_COMMANDS) need Commands');
expect('two components with the same name', variant(a => { comp(a, 'ButtonPoller').name = 'CommandRx'; }),
       'Two components are named CommandRx');
expect('a name that is not a C++ identifier', variant(a => { comp(a, 'ButtonPoller').name = 'Button Poller'; }),
       'is not a C++ identifier', 'C_1');
expect('an actor nothing sends events to (a warning)', variant(a => { a.connections = a.connections.filter(c => c.to !== 'C_2'); }),
       'receives no events from any component', 'C_2', 'warning');

process.exit(failures === 0 ? 0 : 1);
