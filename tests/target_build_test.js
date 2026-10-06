// ==========================================================================
// A firmware project from nothing but its application (tests/fixtures/target): the application drawn top-down
// (the actor without a state machine yet) with the board's Target, then, through the editors' providers
// (tests/fake_vscode.js), Export Application and Generate Board, as a user would click them. run.sh then builds
// the result with the generated CMake presets: it must configure, compile and link as is, board blueprint
// included (docs/design/app-diagram.md section 7).
//   node tests/target_build_test.js <empty dir> [core]
// ==========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const fake = require('./fake_vscode.js');
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? fake : load.call(this, request, ...rest); };
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const [dirArg, core] = process.argv.slice(2);
const dir = path.resolve(dirArg);
const fixture = path.join(__dirname, 'fixtures', 'target');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const f of ['startup.c', 'generic.ld']) fs.copyFileSync(path.join(fixture, f), path.join(dir, f));
const app = JSON.parse(fs.readFileSync(path.join(fixture, 'target.app.json'), 'utf8'));
if (core) app.board.target.core = core;
fs.writeFileSync(path.join(dir, 'Bomb.app.json'), JSON.stringify(app, null, 2));

const { log, providers } = fake.test;
let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  target (${app.board.target.core}): ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
    if (!ok) failures++;
};
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

(async () => {
    ext.activate({ extensionUri: fake.Uri.file(path.join(__dirname, '..')), subscriptions: [] });
    const doc = await fake.workspace.openTextDocument(fake.Uri.file(path.join(dir, 'Bomb.app.json')));
    fake.test.openTabs.push(doc.uri);
    const panel = fake.test.panel();
    await providers['freeactors.appEditor'].resolveCustomTextEditor(doc, panel, {});
    await panel.send({ type: 'ready' });
    const problems = (log.posted.find(m => m.type === 'update') || {}).problems || [];
    check('the application has no errors (the target files exist, the linker script has .noinit)',
          !problems.some(p => p.severity === 'error'), problems);

    await panel.send({ type: 'exportApplication' });
    await panel.send({ type: 'generateBoard' });
    check('Export Application writes the firmware build, FreeRTOSConfig.h and the presets; Generate Board the board',
          ['freeactors_firmware.cmake', 'cmake/arm-none-eabi.cmake', 'FreeRTOSConfig.h', 'freertos_config_user.h',
           'CMakePresets.json', 'CMakeLists.txt', 'bsp_generic.hpp', 'Bomb.hsm.json', 'app_main.cpp'].every(f => fs.existsSync(path.join(dir, f))) &&
          log.error.length === 0, { errors: log.error, info: log.info });
    const firmware = read('freeactors_firmware.cmake');
    check('the firmware build: the core\'s port and flags, the target\'s files and defines, a flash target',
          firmware.includes(`portable/GCC/${ext.TARGET_CORES[app.board.target.core].port}`) &&
          firmware.includes(ext.TARGET_CORES[app.board.target.core].flags[0]) && firmware.includes('${CMAKE_CURRENT_SOURCE_DIR}/startup.c') &&
          firmware.includes('-T${CMAKE_CURRENT_SOURCE_DIR}/generic.ld') && firmware.includes('GENERIC_BOARD=1') &&
          /add_custom_target\(flash\n    COMMAND openocd -f board\/generic\.cfg -c "program \$<TARGET_FILE:bomb> verify reset exit"/.test(firmware), firmware);
    const config = read('FreeRTOSConfig.h');
    check('FreeRTOSConfig.h: priorities from the diagram, the tick hook and static allocation FreeActors needs, overridable',
          /#define configMAX_PRIORITIES 4\b/.test(config) && /#define configUSE_TICK_HOOK 1\b/.test(config) &&
          /#define configSUPPORT_STATIC_ALLOCATION 1\b/.test(config) && /#define configPRIO_BITS 4\b/.test(config) &&
          config.indexOf('#include "freertos_config_user.h"') < config.indexOf('#ifndef configTICK_RATE_HZ'), config);
    check('an interrupt shared by two arrows: one block per arrow, each behind its pending check, with its own acknowledge',
          /if \(Hw::shared_bomb_pending\(\)\) \{\n\s+if \(Hw::shared_bomb_ack\(\)\) \{[\s\S]*IsrCtx::post\(Bomb::ButtonPressed\{\}\);[\s\S]*if \(Hw::shared_commands_pending\(\)\) \{\n\s+IsrCtx::command_rx\(Hw::shared_commands_ack\(\)\);/.test(read('shared_module.hpp')) &&
          /static size_t shared_commands_ack\(\);/.test(read('shared_hw_requirements.hpp')) && /static bool shared_bomb_pending\(\);/.test(read('shared_hw_requirements.hpp')),
          read('shared_module.hpp'));
    check('the interrupts feeding the PC commands (stream arrows into the built-in box) are generated complete',
          /IsrCtx::command_rx\(Hw::command_rx_dma_ack\(\)\)/.test(read('cmdrxdma_module.hpp')) &&
          /static size_t command_rx_dma_ack\(\)/.test(read('cmdrxdma_hw_requirements.hpp')), read('cmdrxdma_module.hpp'));
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.log(`FAIL  target: ${e.stack}`); process.exit(1); });
