// ==========================================================================
// The editors' providers driven end to end over real files (tests/fake_vscode.js stands in for VS Code):
// top-down design (an application drawn first, Export Application creating and exporting the state machine) and
// one source of truth for events (docs/design/app-diagram.md section 7.2) across *.app.json and *.hsm.json.
//   node tests/provider_test.js <empty dir>
// ==========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const fake = require('./fake_vscode.js');
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? fake : load.call(this, request, ...rest); };
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const dir = path.resolve(process.argv[2]);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const { log, providers } = fake.test;
let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  provider: ${name}${ok ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const json = (f) => JSON.parse(fake.test.documents.find(d => d.uri.fsPath === path.join(dir, f))?.getText() ?? read(f));
const exists = (f) => fs.existsSync(path.join(dir, f));

(async () => {
    ext.activate({ extensionUri: fake.Uri.file(path.join(__dirname, '..')), subscriptions: [] });
    const appEditor = providers['freeactors.appEditor'], hsmEditor = providers['freeactors.hsmEditor'];

    // ---- Top-down: the application first ----
    fs.writeFileSync(path.join(dir, 'Timebomb.app.json'), '');
    const appDoc = await fake.workspace.openTextDocument(fake.Uri.file(path.join(dir, 'Timebomb.app.json')));
    fake.test.openTabs.push(appDoc.uri);
    const appPanel = fake.test.panel();
    await appEditor.resolveCustomTextEditor(appDoc, appPanel, {});
    await appPanel.send({ type: 'ready' });
    const app = JSON.parse(appDoc.getText());
    app.board = { type: 'Board::Nucleo', header: 'bsp_nucleo.hpp' };
    app.components.push(
        { id: 'C_1', kind: 'periodic', name: 'ButtonPoller', parent: 'APP', period_ms: 5, priority: 3, stack: 128, x: 70, y: 110, width: 250, height: 96 },
        { id: 'C_2', kind: 'actor', name: 'Timebomb', parent: 'APP', priority: 2, queue: 8, stack: 128, x: 340, y: 110, width: 250, height: 96 });
    app.connections.push({ id: 'L_1', from: 'C_1', to: 'C_2', kind: 'event', events: ['ButtonPressed'] });
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(app, null, 2) });
    const problems = ext.checkAppModel(JSON.parse(appDoc.getText()), []);
    check('an actor drawn without a state machine is a to-do (a warning), not an error',
          problems.some(p => p.severity === 'warning' && p.message.includes('Export Application creates Timebomb.hsm.json')) &&
          !problems.some(p => p.severity === 'error'), problems);

    log.info.length = 0; log.error.length = 0;
    await appPanel.send({ type: 'exportApplication' });
    const hsm = exists('Timebomb.hsm.json') ? json('Timebomb.hsm.json') : {};
    check('Export Application creates the state machine with the events the application sends it, and links it',
          JSON.stringify(hsm.signals) === '["ButtonPressed"]' && hsm.name === 'Timebomb' &&
          JSON.parse(appDoc.getText()).components.find(c => c.id === 'C_2').model === 'Timebomb.hsm.json', { hsm, errors: log.error });
    check('... and exports it with the application: actor, events, requirements, tests, app files, framework',
          ['timebomb_actor.hpp', 'timebomb_events.hpp', 'timebomb_hw_requirements.hpp', 'tests/timebomb_actor_test.cpp',
           'buttonpoller_module.hpp', 'timebomb_app.hpp', 'timebomb_main.cpp', 'freeactors/fa_app.hpp', 'CMakeLists.txt',
           '.clangd', '.vscode/settings.json']
              .every(exists) && /struct ButtonPressed/.test(read('timebomb_events.hpp')) && log.error.length === 0,
          { errors: log.error, info: log.info });

    // ---- Starter files follow the diagram until edited: an interrupt exported before its properties were set ----
    const withIrq = JSON.parse(appDoc.getText());
    withIrq.features = { trace: true, commands: true };
    withIrq.components.push({ id: 'C_9', kind: 'interrupt', name: 'CmdRx', parent: 'APP', irq: '', pri: 6, x: 0, y: 400, width: 250, height: 96 });
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(withIrq, null, 2) });
    await appPanel.send({ type: 'exportApplication' });
    const before = read('cmdrx_module.hpp');
    withIrq.components.find(c => c.id === 'C_9').irq = 'cmd_rx';
    withIrq.components.find(c => c.id === 'C_9').commands = true;
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(withIrq, null, 2) });
    log.info.length = 0;
    await appPanel.send({ type: 'exportApplication' });
    check('an untouched starter file follows the diagram: properties set after the first export reach the module and its requirements',
          /Irq::irq\b/.test(before) && /IsrCtx::command_rx\(Hw::cmd_rx_ack\(\)\)/.test(read('cmdrx_module.hpp')) &&
          /static size_t cmd_rx_ack\(\);/.test(read('cmdrx_hw_requirements.hpp')) &&
          log.info.some(m => m.includes('Updated from the diagram (not edited yet): cmdrx_hw_requirements.hpp, cmdrx_module.hpp')), log.info);
    fs.writeFileSync(path.join(dir, 'cmdrx_module.hpp'), read('cmdrx_module.hpp').replace('static void handler() {', 'static void handler() {   // mine'));
    withIrq.components.find(c => c.id === 'C_9').pri = 7;
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(withIrq, null, 2) });
    await appPanel.send({ type: 'exportApplication' });
    check('... and once edited it is the user\'s: never rewritten', read('cmdrx_module.hpp').includes('static void handler() {   // mine'),
          read('cmdrx_module.hpp'));
    const cleaned = JSON.parse(appDoc.getText());
    cleaned.components = cleaned.components.filter(c => c.id !== 'C_9');
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(cleaned, null, 2) });

    // ---- Events typed in the application become signals of the machine ----
    const app2 = JSON.parse(appDoc.getText());
    app2.connections[0].events = ['ButtonPressed', 'Defuse'];
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(app2, null, 2) });
    check('an event typed on a connection is added to the receiving state machine',
          JSON.stringify(json('Timebomb.hsm.json').signals) === '["ButtonPressed","Defuse"]', json('Timebomb.hsm.json').signals);

    check('a state machine changed while not open in an editor is saved, not left unsaved out of sight',
          JSON.stringify(JSON.parse(read('Timebomb.hsm.json')).signals) === '["ButtonPressed","Defuse"]', read('Timebomb.hsm.json'));

    // ---- The HSM editor: transitions on the signals, then a rename and a delete ----
    const hsmDoc = await fake.workspace.openTextDocument(fake.Uri.file(path.join(dir, 'Timebomb.hsm.json')));
    const hsmPanel = fake.test.panel();
    fake.test.openTabs.push(hsmDoc.uri);
    await hsmEditor.resolveCustomTextEditor(hsmDoc, hsmPanel, {});
    const model = JSON.parse(hsmDoc.getText());
    model.signals.push('Tick');
    model.states.push({ id: 'S_1', name: 'IDLE', parent: 'STATE_ROOT', x: 0, y: 0, width: 100, height: 60,
                        transitions: [{ event: 'ButtonPressed/arm', target: 'S_1' }], local_events: ['ButtonPressed/beep'] });
    await hsmPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(model, null, 2) });
    await hsmPanel.send({ type: 'exportCppBlueprint' });
    fs.writeFileSync(path.join(dir, 'timebomb_events.hpp'),
                     read('timebomb_events.hpp').replace('struct ButtonPressed {', 'struct ButtonPressed {\n    uint8_t presses = 1;'));

    log.info.length = 0;
    await hsmPanel.send({ type: 'renameSignal', from: 'ButtonPressed', to: 'ButtonTap' });
    const renamed = JSON.parse(hsmDoc.getText());
    check('a rename in the HSM editor: the signal list, transitions and internal events',
          renamed.signals.includes('ButtonTap') && !renamed.signals.includes('ButtonPressed') &&
          renamed.states.find(s => s.id === 'S_1').transitions[0].event === 'ButtonTap/arm' &&
          renamed.states.find(s => s.id === 'S_1').local_events[0] === 'ButtonTap/beep', renamed);
    check('... the application\'s connections, and the event struct keeping its fields',
          JSON.stringify(JSON.parse(appDoc.getText()).connections[0].events) === '["ButtonTap","Defuse"]' &&
          /struct ButtonTap \{\n    uint8_t presses = 1;/.test(read('timebomb_events.hpp')) && !/struct ButtonPressed\b/.test(read('timebomb_events.hpp')),
          { connection: JSON.parse(appDoc.getText()).connections[0], info: log.info });
    check('... and both files, open in their editors, stay unsaved there (the user sees and saves them)',
          appDoc.isDirty === true && hsmDoc.isDirty === true, { app: appDoc.isDirty, hsm: hsmDoc.isDirty });

    log.error.length = 0;
    await hsmPanel.send({ type: 'renameSignal', from: 'Defuse', to: 'Tick' });
    await hsmPanel.send({ type: 'renameSignal', from: 'Defuse', to: '9lives' });
    check('a rename onto an existing signal or a non-identifier is refused, changing nothing',
          log.error.length === 2 && JSON.parse(hsmDoc.getText()).signals.includes('Defuse'), log.error);

    // The HSM editor deletes Defuse (unused in transitions) and tells the extension
    const withoutDefuse = JSON.parse(hsmDoc.getText());
    withoutDefuse.signals = withoutDefuse.signals.filter(s => s !== 'Defuse');
    await hsmPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(withoutDefuse, null, 2) });
    log.info.length = 0;
    await hsmPanel.send({ type: 'signalDeleted', name: 'Defuse' });
    check('a signal deleted in the HSM editor is removed from the connections, with a note',
          JSON.stringify(JSON.parse(appDoc.getText()).connections[0].events) === '["ButtonTap"]' &&
          log.info.some(m => m.includes('Defuse deleted') && m.includes('ButtonPoller → Timebomb')), { info: log.info });
    await hsmPanel.send({ type: 'signalDeleted', name: 'ButtonTap' });
    check('... and a connection left without events is removed', JSON.parse(appDoc.getText()).connections.length === 0,
          JSON.parse(appDoc.getText()).connections);

    // ---- A rename from the application editor (an actor's events in its properties) ----
    log.info.length = 0;
    await appPanel.send({ type: 'renameSignal', model: 'Timebomb.hsm.json', from: 'Tick', to: 'Beat' });
    check('a rename from the application editor renames the signal in the state machine',
          JSON.parse(hsmDoc.getText()).signals.includes('Beat') && !JSON.parse(hsmDoc.getText()).signals.includes('Tick'), log);

    // ---- Create State Machine for one actor ----
    const app3 = JSON.parse(appDoc.getText());
    app3.components.push({ id: 'C_3', kind: 'actor', name: 'Logger', parent: 'APP', priority: 1, queue: 4, stack: 128, x: 0, y: 300, width: 250, height: 96 });
    app3.connections.push({ id: 'L_2', from: 'C_1', to: 'C_3', kind: 'event', events: ['Pressed'] });
    await appPanel.send({ type: 'documentEdit', jsonText: JSON.stringify(app3, null, 2) });
    log.commands.length = 0;
    await appPanel.send({ type: 'createStateMachine', id: 'C_3' });
    check('Create State Machine: Logger.hsm.json with its events, linked, opened in the HSM editor',
          exists('Logger.hsm.json') && JSON.stringify(json('Logger.hsm.json').signals) === '["Pressed"]' &&
          JSON.parse(appDoc.getText()).components.find(c => c.id === 'C_3').model === 'Logger.hsm.json' &&
          log.commands.some(c => c[0] === 'vscode.openWith' && c[1].endsWith('Logger.hsm.json')), log.commands);

    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.log(`FAIL  provider: ${e.stack}`); process.exit(1); });
