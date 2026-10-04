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

const legacyInclude = legacy.split('#include "timebomb_hw_requirements.hpp"').join('#include "timebomb_bsp_policy.hpp"');
check('the legacy actor includes the pre-0.0.9 requirements file', legacyInclude.includes('#include "timebomb_bsp_policy.hpp"'));
const once = ext.patchExistingActorHeader(legacyInclude, jsonText).updatedContent;
check('the include is rewritten to the renamed requirements file (timebomb_hw_requirements.hpp)',
      once.includes('#include "timebomb_hw_requirements.hpp"') && !once.includes('bsp_policy'));
const occurrences = once.split(ext.ACTOR_API_MARKER).length - 1;
check('the API block is added exactly once', occurrences === 1 && once.includes(block));
check('it goes right after public:', once.includes('public:\n' + block));
check('user code is untouched', once.includes('this->cancel(Tick{}); }   // user code from before'));

const twice = ext.patchExistingActorHeader(once, jsonText).updatedContent;
check('patching again changes nothing', twice === once);

// The default task settings of an actor from before 0.0.9 are wrapped in #ifndef FA_APP_MANAGED, once
const oldTraits = once.split('#ifndef FA_APP_MANAGED\n').join('').split('#endif // FA_APP_MANAGED\n').join('');
const wrapped = ext.patchExistingActorHeader(oldTraits, jsonText).updatedContent;
check('an old default traits block is wrapped in #ifndef FA_APP_MANAGED (the application sets the task)',
      !oldTraits.includes('#ifndef FA_APP_MANAGED') && /#ifndef FA_APP_MANAGED[^\n]*\nnamespace Fa \{[\s\S]*struct ActorTraits<Timebomb::Actor[\s\S]*\} \/\/ namespace Fa\n#endif \/\/ FA_APP_MANAGED/.test(wrapped));
check('wrapping again changes nothing', ext.patchExistingActorHeader(wrapped, jsonText).updatedContent === wrapped);
fs.writeFileSync(outPath, once);

// Events: a header from before 0.0.8 (tool-owned banner) is converted once into the user-owned form,
// keeping fields added by hand; a signal without a struct is appended; nothing else changes
const legacyEvents = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_timebomb_events.hpp'), 'utf8');
const converted = ext.patchExistingEventsHeader(legacyEvents, jsonText);
const ev = converted.updatedContent;
check('events: a pre-0.0.8 header is converted', converted.converted && !ev.includes(ext.LEGACY_EVENTS_BANNER));
check('events: the hand-added field is kept', ev.includes('struct ButtonPressed { uint8_t presses = 1; };   // a field added by hand'));
check('events: each struct appears once, no variant left',
      ev.split('struct Tick').length === 2 && ev.split('struct ButtonPressed').length === 2 && !ev.includes('std::variant'));
check('events: converting again changes nothing', ext.patchExistingEventsHeader(ev, jsonText).updatedContent === ev);
const withoutTick = ev.replace('struct Tick {};\n', '');
const appended = ext.patchExistingEventsHeader(withoutTick, jsonText);
check('events: a new signal is appended as an empty struct',
      appended.added.join() === 'Tick' && appended.updatedContent.includes('struct Tick {};\n\n} // namespace Timebomb'));
fs.writeFileSync(path.join(path.dirname(outPath), 'timebomb_events.hpp'), ev);
// as on export: the event list is regenerated from the converted events (its layout checks include the new field)
const list = ext.generateCppEventListString(jsonText, ev);
check('events: the event list pins the hand-added field', list.includes('sizeof(Timebomb::ButtonPressed) == 1'));
fs.writeFileSync(path.join(path.dirname(outPath), 'timebomb_event_list.hpp'), list);
process.exit(failures === 0 ? 0 : 1);
