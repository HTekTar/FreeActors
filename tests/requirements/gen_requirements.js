// Generates contracts and test doubles for the requirement fixtures, the application-wide contract, and checks
// the conflict detection. Writes into the directory given; prints PASS/FAIL for the conflict checks.
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? {} : load.call(this, r, ...a); };
const ext = require(path.join(__dirname, '..', '..', 'out', 'extension.js'));
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const sources = {
    Timebomb: fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'timebomb.hw_requirements.hpp'), 'utf8'),
    ButtonPoller: fs.readFileSync(path.join(__dirname, 'buttonpoller.hw_requirements.hpp'), 'utf8'),
    CommandRxIsr: fs.readFileSync(path.join(__dirname, 'commandrxisr.hw_requirements.hpp'), 'utf8'),
};
for (const [owner, content] of Object.entries(sources)) {
    const lower = owner.toLowerCase();
    fs.writeFileSync(path.join(out, `${lower}_hw_requirements.hpp`), content);
    fs.writeFileSync(path.join(out, `${lower}_hw_contract.hpp`), ext.generateCpHwContractString(owner, content));
    fs.writeFileSync(path.join(out, `${lower}_test_bsp.hpp`), ext.generateCppTestBspString(owner, content));
}
fs.writeFileSync(path.join(out, 'myapp_hw_contract.hpp'), ext.generateAppHwContractString('MyApp', Object.keys(sources)));

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  requirements: ${name}${ok ? '' : ' — ' + detail}`); if (!ok) failures++; };
const reqs = Object.entries(sources).map(([o, c]) => ext.moduleRequirements(o, c));
check('interrupt numbers are read from struct Irq', JSON.stringify(reqs[2].irqs) === '["command_rx_dma","command_rx_uart"]', JSON.stringify(reqs[2]));
check('the modules of one application do not conflict (read_button, required by two modules alike, is shared)',
      ext.findRequirementConflicts(reqs).length === 0 && reqs[0].functions.some(f => f.name === 'read_button') &&
      reqs[1].functions.some(f => f.name === 'read_button'),
      JSON.stringify(ext.findRequirementConflicts(reqs)));
const clash = ext.moduleRequirements('Display', 'namespace Display { struct HwRequirements { static void set_led(uint8_t level); struct Irq { static const int command_rx_uart; }; }; }');
const conflicts = ext.findRequirementConflicts([...reqs, clash]);
check('one function required with two signatures is a conflict naming both modules',
      conflicts.some(c => c.includes('Board function set_led') && c.includes('Timebomb: static void set_led(bool)') && c.includes('Display: static void set_led(uint8_t)')),
      JSON.stringify(conflicts));
check('one interrupt required by two modules is a conflict',
      conflicts.some(c => c.includes('Irq::command_rx_uart is required by CommandRxIsr and Display')), JSON.stringify(conflicts));
process.exit(failures ? 1 : 0);
