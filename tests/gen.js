// Runs the extension's C++ generator outside VS Code (the 'vscode' module is stubbed out).
//
//   node tests/gen.js <model.hsm.json> <outDir>                  write the files Export would write for a new
//                                                                project: events, blueprint, BSP policy stub,
//                                                                hardware contract, and actor header stub
//   node tests/gen.js --project <model.hsm.json> <dir>           write a complete new project exactly as Export
//                                                                would (sources, CMake, tests/, freeactors/)
//   node tests/gen.js --expect-error <model.hsm.json> <text>     succeed only if generation is rejected
//                                                                with an error message containing <text>
const fs = require('fs');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return {};
    }
    return originalLoad.call(this, request, ...rest);
};

const ext = require('../out/extension.js');

// A fixture may supply its own BSP policy (<model>.bsp_policy.hpp) in place of the starter stub.
function generate(jsonText, modelPath) {
    ext.validateHsmModel(jsonText);
    const name = JSON.parse(jsonText).name.replace(/[^a-zA-Z0-9_]/g, '');
    const bspFixture = modelPath.replace(/\.hsm\.json$/, '.bsp_policy.hpp');
    const bspPolicy = fs.existsSync(bspFixture)
        ? fs.readFileSync(bspFixture, 'utf8')
        : ext.generateCppBspPolicyStarterStub(name);
    return {
        events: ext.generateCppEventsHeaderString(jsonText),
        hsm: ext.generateCppBlueprintString(jsonText),
        bsp_policy: bspPolicy,
        hw_contract: ext.generateCpHwContractString(name, bspPolicy),
        actor: ext.generateCppConcreteHeaderStub(jsonText),
        test_bsp: ext.generateCppTestBspString(name, bspPolicy),
    };
}

const args = process.argv.slice(2);

if (args[0] === '--expect-error') {
    const [, modelPath, expected] = args;
    try {
        generate(fs.readFileSync(modelPath, 'utf8'), modelPath);
    } catch (err) {
        if (String(err.message).includes(expected)) {
            console.log(`PASS  ${path.basename(modelPath)} rejected: ${err.message}`);
            process.exit(0);
        }
        console.log(`FAIL  ${path.basename(modelPath)} rejected with unexpected message: ${err.message}`);
        process.exit(1);
    }
    console.log(`FAIL  ${path.basename(modelPath)} was accepted, expected an error containing "${expected}"`);
    process.exit(1);
}

if (args[0] === '--project') {
    const [, modelPath, dir] = args;
    const jsonText = fs.readFileSync(modelPath, 'utf8');
    const lowerName = JSON.parse(jsonText).name.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
    const headers = generate(jsonText, modelPath);
    const files = {
        'main.cpp': ext.generateCppCliSimulatorString(jsonText),
        'CMakeLists.txt': ext.generateCMakeListsString(jsonText),
        [ext.TESTS_CMAKE_FILENAME]: ext.generateTestsCMakeString(jsonText),
        [`tests/${lowerName}_model_test.cpp`]: ext.generateCppModelTestStub(jsonText),
        [`tests/${lowerName}_actor_test.cpp`]: ext.generateCppActorTestStub(jsonText),
    };
    for (const [suffix, content] of Object.entries(headers)) {
        files[`${lowerName}_${suffix}.hpp`] = content;
    }
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    fs.mkdirSync(path.join(dir, 'freeactors'), { recursive: true });
    for (const lib of ext.FRAMEWORK_FILES) {
        fs.copyFileSync(path.join(__dirname, '..', 'freeactors_lib', lib), path.join(dir, 'freeactors', lib));
    }
    process.exit(0);
}

const [modelPath, outDir] = args;
const jsonText = fs.readFileSync(modelPath, 'utf8');
const lowerName = JSON.parse(jsonText).name.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
fs.mkdirSync(outDir, { recursive: true });
for (const [suffix, content] of Object.entries(generate(jsonText, modelPath))) {
    fs.writeFileSync(path.join(outDir, `${lowerName}_${suffix}.hpp`), content);
}
fs.writeFileSync(path.join(outDir, `${lowerName}_trace.json`), ext.generateTraceDictionaryString(jsonText));
