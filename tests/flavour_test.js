// ==========================================================================
// The STM32F4 + HAL flavour from an empty folder: the application drawn top-down (tests/fixtures/target's,
// on a Nucleo-F446ZE), its Target given only the flavour, the part and the SDK folder; then, through the editors'
// providers (tests/fake_vscode.js), Apply flavour, Export Application and Generate Board. run.sh builds the
// result with the generated presets: ST's startup, system file and HAL, the generated board blueprint as is.
//   node tests/flavour_test.js <empty dir> <SDK folder with cmsis_core, cmsis_device_f4, stm32f4xx_hal_driver>
// ==========================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const fake = require('./fake_vscode.js');
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? fake : load.call(this, request, ...rest); };
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const [dirArg, sdkArg] = process.argv.slice(2);
const dir = path.resolve(dirArg);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'third_party'), { recursive: true });
fs.symlinkSync(path.resolve(sdkArg), path.join(dir, 'third_party', 'st'));
const app = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'target', 'target.app.json'), 'utf8'));
app.board = { type: 'Board::NucleoF446ZE', header: 'bsp_nucleo_f446ze.hpp',
              target: { flavour: 'stm32f4-hal', part: 'STM32F446xx', sdk: 'third_party/st', flash_kb: 512, ram_kb: 128 } };
fs.writeFileSync(path.join(dir, 'Bomb.app.json'), JSON.stringify(app, null, 2));

const { log, providers } = fake.test;
let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  flavour (STM32F4 + HAL): ${name}${ok ? '' : ` — ${JSON.stringify(detail)}`}`);
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
    await panel.send({ type: 'applyFlavour' });
    const target = JSON.parse(doc.getText()).board.target;
    check('Apply flavour fills in the Target from the part and the SDK folder',
          target.core === 'cortex-m4f' && target.startup === 'third_party/st/cmsis_device_f4/Source/Templates/gcc/startup_stm32f446xx.s' &&
          target.defines.includes('STM32F446xx') && target.sources.includes('bsp_nucleo_f446ze.cpp') &&
          target.linker_script === 'firmware/stm32f446xx_flash.ld' && /openocd .*\{elf\}/.test(target.flash), target);
    check('... and creates the linker script (with .noinit), the HAL configuration from ST\'s template and the HAL tick glue',
          /\.noinit \(NOLOAD\)/.test(read('firmware/stm32f446xx_flash.ld')) && /LENGTH = 512K/.test(read('firmware/stm32f446xx_flash.ld')) &&
          /HAL_RCC_MODULE_ENABLED/.test(read('firmware/stm32f4xx_hal_conf.h')) && /HAL_GetTick/.test(read('bsp_nucleo_f446ze.cpp')),
          log.info);

    await panel.send({ type: 'exportApplication' });
    await panel.send({ type: 'generateBoard' });
    const board = read('bsp_nucleo_f446ze.hpp');
    check('Generate Board with the flavour: the HAL header, HAL_Init() first in init(), the interrupt count from the device header',
          board.includes('#include "stm32f4xx_hal.h"') && /static void init\(\) \{\n\s+HAL_Init\(\);/.test(board) &&
          /irq_count = 97;/.test(board) && log.error.length === 0, { board: board.slice(0, 1500), errors: log.error });
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.log(`FAIL  flavour: ${e.stack}`); process.exit(1); });
