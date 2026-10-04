// Generates the Minimal application (tests/fixtures/app) into a directory, as Export Application would:
// the application files, with the state machine's files from tests/gen.js and the user-owned fixture files.
//   node tests/app_gen_test.js <out dir>
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const load = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? {} : load.call(this, r, ...a); };
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));
const out = process.argv[2];
const fixtures = path.join(__dirname, 'fixtures');
const appDir = path.join(fixtures, 'app');
fs.mkdirSync(out, { recursive: true });

const app = JSON.parse(fs.readFileSync(path.join(appDir, 'minimal.app.json'), 'utf8'));
const models = [ext.describeHsmModel('timebomb.hsm.json', fs.readFileSync(path.join(fixtures, 'timebomb.hsm.json'), 'utf8'))];
const problems = ext.checkAppModel(app, models);
if (problems.length > 0) { console.log(`FAIL  app generation: the Minimal fixture has problems: ${JSON.stringify(problems)}`); process.exit(1); }

for (const f of fs.readdirSync(appDir)) if (!f.endsWith('.app.json')) fs.copyFileSync(path.join(appDir, f), path.join(out, f));
const owners = ['Timebomb', 'ButtonPoller', 'Tap'];   // requirement files present (Timebomb's from tests/gen.js)
for (const [file, content] of Object.entries(ext.generateAppFiles(app, models, owners))) fs.writeFileSync(path.join(out, file), content);
for (const owner of ['ButtonPoller', 'Tap']) {
    const req = fs.readFileSync(path.join(appDir, `${owner.toLowerCase()}_hw_requirements.hpp`), 'utf8');
    fs.writeFileSync(path.join(out, `${owner.toLowerCase()}_hw_contract.hpp`), ext.generateCpHwContractString(owner, req));
}
console.log(`PASS  app generation: ${Object.keys(ext.generateAppFiles(app, models, owners)).join(', ')}`);
