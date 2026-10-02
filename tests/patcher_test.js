// ==========================================================================
// patchExistingActorHeader on an actor written before the actor API block existed:
// the block is added once, user code is untouched, and patching again changes nothing.
//   node tests/patcher_test.js <model.hsm.json> <out_actor.hpp>
// Writes the patched header to out_actor.hpp; run.sh then compiles it. Exits non-zero on failure.
// ==========================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

// The generator imports 'vscode' at load time; it is not used by the functions tested here
const load = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
};
const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const [modelPath, outPath] = process.argv.slice(2);
const jsonText = fs.readFileSync(modelPath, 'utf8');
let failures = 0;
const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  patcher: ${name}`);
    if (!ok) failures++;
};

// An actor from before: the fresh stub without the block, plus user code that still uses this->
const block = ext.generateActorApiBlock();
const userCode = /void entry_ROOT\(\) \{\n[^\n]*\n\s*\}/;
const legacy = ext.generateCppConcreteHeaderStub(jsonText)
    .replace(block + '\n', '')
    .replace(userCode, 'void entry_ROOT() { this->cancel(Tick{}); }   // user code from before');
check('the legacy actor has no API block, and has user code using this->',
      !legacy.includes(ext.ACTOR_API_MARKER) && legacy.includes('this->cancel(Tick{}); }   // user code from before'));

const once = ext.patchExistingActorHeader(legacy, jsonText).updatedContent;
const occurrences = once.split(ext.ACTOR_API_MARKER).length - 1;
check('the API block is added exactly once', occurrences === 1 && once.includes(block));
check('it goes right after public:', once.includes('public:\n' + block));
check('user code is untouched', once.includes('this->cancel(Tick{}); }   // user code from before'));

const twice = ext.patchExistingActorHeader(once, jsonText).updatedContent;
check('patching again changes nothing', twice === once);

fs.writeFileSync(outPath, once);
process.exit(failures === 0 ? 0 : 1);
