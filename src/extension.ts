import * as vscode from 'vscode';

function uint8ArrayToString(arr: Uint8Array): string {
    return new (globalThis as any).TextDecoder('utf-8').decode(arr);
}

function stringToUint8Array(str: string): Uint8Array {
    return new (globalThis as any).TextEncoder().encode(str);
}

// Returns undefined only when the file does not exist; any other failure is rethrown so that
// user-owned files are never regenerated over (e.g. on permission or I/O errors).
async function readFileIfExists(uri: vscode.Uri): Promise<string | undefined> {
    try {
        return uint8ArrayToString(await vscode.workspace.fs.readFile(uri));
    } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            return undefined;
        }
        throw err;
    }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch (err) {
        if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            return false;
        }
        throw err;
    }
}

// ---- Edits across files (signal sync, top-down creation) --------------------------------------------------

function isOpenInTab(uri: vscode.Uri): boolean {
    return vscode.window.tabGroups.all.some(g => g.tabs.some(t => {
        const input = t.input as any;
        return input && input.uri && input.uri.toString() === uri.toString();
    }));
}

// Applies a workspace edit; files it changed that are not open in a tab are saved, so no change is left unsaved
// out of sight (an open one stays unsaved in its editor, where the user sees it)
async function applyAndSave(edit: vscode.WorkspaceEdit): Promise<boolean> {
    if (edit.size === 0) return false;
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    for (const [uri] of edit.entries()) {
        if (!isOpenInTab(uri)) {
            const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (doc && doc.isDirty) await doc.save();
        }
    }
    return true;
}

// Changes a JSON document (a *.hsm.json or *.app.json) as an edit to its text, so an open editor follows at once.
// mutate returns true if it changed the object. The text is written as the editors write it (2-space JSON).
async function editJsonDocument(uri: vscode.Uri, mutate: (json: any) => boolean): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(uri);
    let json: any;
    try { json = JSON.parse(doc.getText()); } catch { return false; }
    if (!mutate(json)) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify(json, null, 2));
    return applyAndSave(edit);
}

async function appFilesIn(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
    return (await vscode.workspace.fs.readDirectory(folderUri))
        .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.app.json'))
        .map(([name]) => vscode.Uri.joinPath(folderUri, name));
}

// Renames the event struct in the user's events header: through the language server's rename (clangd) when one
// runs, which also renames the uses in the user's code; else in the header only (the compiler shows the uses)
async function renameEventStructInCode(folderUri: vscode.Uri, machine: string, from: string, to: string): Promise<string> {
    const uri = vscode.Uri.joinPath(folderUri, `${machine.toLowerCase()}_events.hpp`);
    const text = await readFileIfExists(uri);
    if (text === undefined) return '';
    const m = new RegExp(`\\bstruct\\s+${from}\\s*[{;:]`).exec(text);
    if (!m) return '';
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const position = doc.positionAt(m.index + m[0].indexOf(from));
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>('vscode.executeDocumentRenameProvider', uri, position, to);
        if (edit && edit.size > 0 && await applyAndSave(edit)) {
            return `struct ${machine}::${from} renamed in your code (${edit.size} file${edit.size === 1 ? '' : 's'})`;
        }
    } catch { /* no rename provider (clangd not running): the header only */ }
    const edit = new vscode.WorkspaceEdit();
    const doc = await vscode.workspace.openTextDocument(uri);
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), renameEventStruct(doc.getText(), from, to));
    await applyAndSave(edit);
    return `struct ${from} renamed in ${machine.toLowerCase()}_events.hpp (other uses in your code: the compiler points them out)`;
}

// A signal renamed in one model: the model, every application in the folder, the events struct. Returns a note.
async function renameSignalEverywhere(folderUri: vscode.Uri, modelFile: string, from: string, to: string): Promise<string> {
    if (!IDENTIFIER.test(to)) throw new Error(`"${to}" is not a C++ identifier (an event is a struct)`);
    const modelUri = vscode.Uri.joinPath(folderUri, modelFile);
    const hsm = JSON.parse((await vscode.workspace.openTextDocument(modelUri)).getText());
    if (Array.isArray(hsm.signals) && hsm.signals.includes(to)) throw new Error(`${modelFile} already has a signal ${to}`);
    const changed: string[] = [];
    for (const appUri of await appFilesIn(folderUri)) {
        if (await editJsonDocument(appUri, app => renameSignalInApp(app, modelFile, from, to))) changed.push(appUri.path.split('/').pop()!);
    }
    const code = await renameEventStructInCode(folderUri, machineNameOf(hsm), from, to);
    if (await editJsonDocument(modelUri, m => renameSignalInModel(m, from, to))) changed.unshift(modelFile);
    return `Renamed ${from} to ${to} in ${changed.join(', ')}${code ? `; ${code}` : ''}.`;
}

// A signal deleted from a model: removed from the connections of every application in the folder. Returns a note.
async function removeSignalEverywhere(folderUri: vscode.Uri, modelFile: string, signal: string): Promise<string | undefined> {
    const notes: string[] = [];
    for (const appUri of await appFilesIn(folderUri)) {
        let names: string[] = [];
        await editJsonDocument(appUri, app => (names = removeSignalFromApp(app, modelFile, signal)).length > 0);
        if (names.length > 0) notes.push(`${appUri.path.split('/').pop()} (${names.join(', ')})`);
    }
    return notes.length > 0 ? `${signal} deleted: removed from the connections in ${notes.join(', ')}.` : undefined;
}

// Signals the application sends that its models lack: added to the models. Returns a note, or undefined.
async function addSentSignalsToModels(folderUri: vscode.Uri, app: any, models: AppModelInfo[]): Promise<string | undefined> {
    const notes: string[] = [];
    for (const [file, signals] of Object.entries(signalsMissingFromModels(app, models))) {
        const added = await editJsonDocument(vscode.Uri.joinPath(folderUri, file), hsm => {
            hsm.signals = Array.isArray(hsm.signals) ? hsm.signals : [];
            const add = signals.filter(s => !hsm.signals.includes(s));
            hsm.signals.push(...add);
            return add.length > 0;
        });
        if (added) notes.push(`${signals.join(', ')} to ${file}`);
    }
    return notes.length > 0 ? `Added ${notes.join('; ')} (the application sends them).` : undefined;
}

// freeactors_lib headers copied into every exported project's freeactors/ folder
export const FRAMEWORK_FILES = [
    'fa_app.hpp',
    'fa_common.hpp',
    'fa_core.hpp', 
    'fa_freertos.hpp',
    'fa_timeEvent.hpp', 
    'fa_util.hpp', 
    'fa_ops.hpp', 
    'fa_trace.hpp',
    'fa_sim.hpp',
    'fa_repl.hpp',
    'fa_test.hpp',
    'fa_frame.hpp',
    'fa_trace_service.hpp',
    'fa_cortexm.hpp',
    'fa_spsc.hpp',
    'fa_dma.hpp',
    'fa_command_service.hpp',
    'fa_health.hpp',
    'fa_health_monitor.hpp',
    'fa_interrupt.hpp',
    'doctest.h'
];

export async function copyFrameworkFilesToWorkspace(context: vscode.ExtensionContext, folderUri: vscode.Uri) {
    const destinationDirUri = vscode.Uri.joinPath(folderUri, 'freeactors');
    const sourceDirUri = vscode.Uri.joinPath(context.extensionUri, 'out', 'freeactors_lib');   // packaged copy

    try {
        await vscode.workspace.fs.createDirectory(destinationDirUri);
        for (const filename of FRAMEWORK_FILES) {
            const srcFileUri = vscode.Uri.joinPath(sourceDirUri, filename);
            const destFileUri = vscode.Uri.joinPath(destinationDirUri, filename);

            try {
                const fileData = await vscode.workspace.fs.readFile(srcFileUri);
                await vscode.workspace.fs.writeFile(destFileUri, fileData);
            } catch (fileErr: any) {
                console.warn(`[FreeActors] Could not copy ${filename}: ${fileErr.message}`);
            }
        }
        // The trace decoder, so projects can run: node freeactors/fa-trace.js --dict . --serial <port>
        try {
            const decoder = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'out', 'fa-trace.js'));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(destinationDirUri, 'fa-trace.js'), decoder);
        } catch (fileErr: any) {
            console.warn(`[FreeActors] Could not copy fa-trace.js: ${fileErr.message}`);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`❌ Framework Sync Failed: ${error.message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(FreeActorsEditorProvider.register(context));
    context.subscriptions.push(FreeActorsAppEditorProvider.register(context));
}

// ==========================================================================
// APPLICATION MODEL (*.app.json, docs/design/app-diagram.md)
// ==========================================================================

// The model of a new, empty application file: the application itself as the root component (the board frame)
export function defaultAppModel(name: string): object {
    return {
        name,
        board: { type: "Board::MyBoard", header: "bsp_my_board.hpp" },
        features: { trace: true, commands: false, health: false, debug_commands: false },
        settings: {},
        components: [
            { id: "APP", kind: "application", name, x: 40, y: 40, width: 980, height: 600 }
        ],
        connections: []
    };
}

// A state machine model the application editor can use: file (relative to the folder), name, signals
export interface AppModelInfo { file: string; name: string; signals: string[]; }

export function describeHsmModel(file: string, jsonText: string): AppModelInfo | undefined {
    try {
        const hsm = JSON.parse(jsonText);
        const signals = ((hsm.signals || []) as unknown[])
            .map(s => (typeof s === 'string' ? s : String((s as any)?.name ?? '')).trim())
            .filter(s => s.length > 0);
        return { file, name: machineNameOf(hsm), signals };
    } catch (e) {
        return undefined;
    }
}

// ==========================================================================
// SIGNALS: ONE SOURCE OF TRUTH (docs/design/app-diagram.md section 7.2). The receiving state machine owns its
// signals; the events on connections in *.app.json refer to them. These pure functions apply one change to one
// model or application; FreeActorsAppEditorProvider / FreeActorsEditorProvider apply them across the files.
// ==========================================================================

const IDENTIFIER = /^[A-Za-z_]\w*$/;

// The signal part of a transition's or internal event's "Signal/action" text (internal events may carry a '·')
function renameSignalIn(text: string, from: string, to: string): string {
    const m = /^(\s*·?\s*)([A-Za-z_]\w*)(.*)$/s.exec(text);
    return m && m[2] === from ? `${m[1]}${to}${m[3]}` : text;
}

// The model with the signal renamed in its signal list, transitions and internal events; false if absent
export function renameSignalInModel(hsm: any, from: string, to: string): boolean {
    if (!Array.isArray(hsm.signals) || !hsm.signals.includes(from)) return false;
    hsm.signals = hsm.signals.map((s: string) => (s === from ? to : s));
    for (const s of (hsm.states || []) as any[]) {
        for (const t of (s.transitions || []) as any[]) if (typeof t.event === 'string') t.event = renameSignalIn(t.event, from, to);
        if (Array.isArray(s.local_events)) s.local_events = s.local_events.map((e: any) => (typeof e === 'string' ? renameSignalIn(e, from, to) : e));
    }
    return true;
}

// The file Export Application creates for an actor drawn without a state machine (top-down design)
export function plannedModelFile(actorName: string): string {
    return `${actorName}.hsm.json`;
}

// Event connections into the actors using the model (by file name)
function eventConnectionsInto(app: any, modelFile: string): any[] {
    const actors = new Set(((app.components || []) as any[]).filter(c => c.kind === 'actor' && c.model === modelFile).map(c => c.id));
    return ((app.connections || []) as any[]).filter(x => x.kind === 'event' && actors.has(x.to) && Array.isArray(x.events));
}

// The application with the signal renamed on every connection into the model's actors; true if anything changed
export function renameSignalInApp(app: any, modelFile: string, from: string, to: string): boolean {
    let changed = false;
    for (const conn of eventConnectionsInto(app, modelFile)) {
        if (conn.events.includes(from)) { conn.events = conn.events.map((e: string) => (e === from ? to : e)); changed = true; }
    }
    return changed;
}

// The application without the signal on connections into the model's actors; a connection left without events
// is removed. Returns the names of the connections changed ("ButtonPoller → Timebomb")
export function removeSignalFromApp(app: any, modelFile: string, signal: string): string[] {
    const names: string[] = [];
    const emptied = new Set<string>();
    const nameOf = (id: string) => (((app.components || []) as any[]).find(c => c.id === id) || { name: id }).name;
    for (const conn of eventConnectionsInto(app, modelFile)) {
        if (!conn.events.includes(signal)) continue;
        conn.events = conn.events.filter((e: string) => e !== signal);
        names.push(`${nameOf(conn.from)} → ${nameOf(conn.to)}`);
        if (conn.events.length === 0) emptied.add(conn.id);
    }
    app.connections = ((app.connections || []) as any[]).filter(x => !emptied.has(x.id));
    return names;
}

// The signals the application sends to each model that the model does not have yet: { model file: [signals] }
export function signalsMissingFromModels(app: any, models: AppModelInfo[]): { [file: string]: string[] } {
    const missing: { [file: string]: string[] } = {};
    for (const m of models) {
        const sent = eventConnectionsInto(app, m.file).flatMap(x => x.events as string[]);
        const add = [...new Set(sent)].filter(s => IDENTIFIER.test(s) && !m.signals.includes(s));
        if (add.length > 0) missing[m.file] = add;
    }
    return missing;
}

// The events header (user-owned) with the struct renamed, fields kept; unchanged if the struct is not there
export function renameEventStruct(eventsText: string, from: string, to: string): string {
    return eventsText.replace(new RegExp(`(\\bstruct\\s+)${from}(\\s*[{;:])`), `$1${to}$2`);
}

// ==========================================================================
// THE TARGET (docs/design/app-diagram.md section 7.5): the board's build decisions, under board.target in
// *.app.json; Export Application generates the firmware build and FreeRTOSConfig.h from them and the diagram.
// ==========================================================================

// The cores FreeActors supports (ARMv7-M and ARMv8-M Mainline: NVIC with VTOR): compiler flags, FreeRTOS port
export const TARGET_CORES: { [core: string]: { label: string; flags: string[]; port: string; portSources: string[] } } = {
    'cortex-m3':  { label: 'Cortex-M3', flags: ['-mcpu=cortex-m3', '-mthumb'], port: 'ARM_CM3', portSources: ['port.c'] },
    'cortex-m4':  { label: 'Cortex-M4 (no FPU)', flags: ['-mcpu=cortex-m4', '-mthumb', '-mfloat-abi=soft'], port: 'ARM_CM3', portSources: ['port.c'] },
    'cortex-m4f': { label: 'Cortex-M4F', flags: ['-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard'], port: 'ARM_CM4F', portSources: ['port.c'] },
    'cortex-m7':  { label: 'Cortex-M7 (double-precision FPU)', flags: ['-mcpu=cortex-m7', '-mthumb', '-mfpu=fpv5-d16', '-mfloat-abi=hard'], port: 'ARM_CM4F', portSources: ['port.c'] },
    'cortex-m33': { label: 'Cortex-M33 (FPU, no TrustZone)', flags: ['-mcpu=cortex-m33', '-mthumb', '-mfpu=fpv5-sp-d16', '-mfloat-abi=hard'],
                    port: 'ARM_CM33_NTZ/non_secure', portSources: ['port.c', 'portasm.c'] },
};

export interface Target {
    core?: string; nvic_prio_bits?: number; tick_hz?: number; toolchain?: string; freertos?: string;
    linker_script?: string; startup?: string; sources?: string[]; includes?: string[]; defines?: string[]; flash?: string;
    flavour?: string; part?: string; sdk?: string; flash_kb?: number; ram_kb?: number;
}

export function targetOf(app: any): Target { return (app && app.board && app.board.target) || {}; }

export const FIRMWARE_CMAKE_FILENAME = 'freeactors_firmware.cmake';
export const TOOLCHAIN_FILENAME = 'cmake/arm-none-eabi.cmake';
export const FREERTOS_USER_CONFIG_FILENAME = 'freertos_config_user.h';

// A path from the Target as CMake reads it: relative to the project, absolute as is, $env{X} from the environment
function cmakePath(p: string): string {
    const t = p.trim().replace(/\$env\{(\w+)\}/g, '$ENV{$1}');
    return /^(\/|[A-Za-z]:[\\/]|\$)/.test(t) ? t : `\${CMAKE_CURRENT_SOURCE_DIR}/${t}`;
}

// A command line split into arguments, honouring "double" and 'single' quotes
function splitCommand(command: string): string[] {
    const args: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) args.push(m[1] ?? m[2] ?? m[3] ?? '');
    return args;
}

export function generateToolchainFile(app: any): string {
    const dir = (targetOf(app).toolchain || '').trim().replace(/[\\/]+$/, '');
    const prefix = dir ? `${dir}/arm-none-eabi-` : 'arm-none-eabi-';
    let out = `# AUTO-GENERATED - DO NOT HAND-EDIT (from ${app.name}.app.json, the board's Target: Export Application)\n`;
    out += `# CMake toolchain file: GNU Arm Embedded (arm-none-eabi-gcc), bare metal. Used by the "firmware" preset.\n\n`;
    out += `set(CMAKE_SYSTEM_NAME Generic)\nset(CMAKE_SYSTEM_PROCESSOR arm)\n\n`;
    out += `set(CMAKE_C_COMPILER   ${prefix}gcc)\nset(CMAKE_CXX_COMPILER ${prefix}g++)\nset(CMAKE_ASM_COMPILER ${prefix}gcc)\n`;
    out += `set(CMAKE_OBJCOPY      ${prefix}objcopy CACHE FILEPATH "objcopy")\nset(CMAKE_SIZE         ${prefix}size CACHE FILEPATH "size")\n\n`;
    out += `# Test-compile a static library: linking a test program would need a linker script\n`;
    out += `set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n\n`;
    out += `set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)\nset(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)\nset(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)\n`;
    return out;
}

// CMakePresets.json: "host" (simulator and tests) and "firmware". Marked as FreeActors' so a later export may
// rewrite it; your own presets go in CMakeUserPresets.json
export function generateCMakePresets(app: any): string {
    const presets = {
        version: 3,
        cmakeMinimumRequired: { major: 3, minor: 21, patch: 0 },
        vendor: { freeactors: { generated: `from ${app.name}.app.json by Export Application; your own presets: CMakeUserPresets.json` } },
        configurePresets: [
            { name: 'host', displayName: 'Host: REPL simulator + tests', binaryDir: '${sourceDir}/build',
              cacheVariables: { CMAKE_EXPORT_COMPILE_COMMANDS: 'ON' } },
            { name: 'firmware', displayName: `Firmware: ${app.board?.type || 'the board'} (arm-none-eabi)`, binaryDir: '${sourceDir}/build-fw',
              toolchainFile: '${sourceDir}/' + TOOLCHAIN_FILENAME,
              cacheVariables: { CMAKE_BUILD_TYPE: 'MinSizeRel', CMAKE_EXPORT_COMPILE_COMMANDS: 'ON' } },
        ],
        buildPresets: [{ name: 'host', configurePreset: 'host' }, { name: 'firmware', configurePreset: 'firmware' }],
        testPresets: [{ name: 'host', configurePreset: 'host', output: { outputOnFailure: true } }],
    };
    return JSON.stringify(presets, null, 2) + '\n';
}

export function generateFirmwareCMake(app: any): string {
    const t = targetOf(app);
    const core = TARGET_CORES[t.core || ''] || TARGET_CORES['cortex-m4f']!;
    const name = String(app.name).toLowerCase();
    const list = (xs: string[] | undefined) => (xs || []).map(s => s.trim()).filter(Boolean);
    const freertos = (t.freertos || '').trim() ? cmakePath(t.freertos!) : '$ENV{FREERTOS_KERNEL_PATH}';
    let out = `# ==========================================================================\n`;
    out += `# AUTO-GENERATED FIRMWARE BUILD - DO NOT HAND-EDIT (from ${app.name}.app.json: the board's Target, Export Application)\n`;
    out += `# Included by CMakeLists.txt when cross-compiling (the "firmware" preset): ${name}.elf and .bin, the memory use,\n`;
    out += `# and a "flash" target.\n`;
    out += `#   cmake --preset firmware && cmake --build --preset firmware                 # build\n`;
    out += `#   cmake --build --preset firmware --target flash                             # program the board\n`;
    out += `# ==========================================================================\n\n`;
    out += `enable_language(C ASM)\n\n`;
    out += `set(FREERTOS_KERNEL_PATH "${freertos}" CACHE PATH "FreeRTOS kernel 'Source' folder")\n`;
    out += `if(NOT EXISTS "\${FREERTOS_KERNEL_PATH}/include/FreeRTOS.h")\n`;
    out += `    message(FATAL_ERROR "FreeRTOS kernel not found at '\${FREERTOS_KERNEL_PATH}': set it in the application's Target, or FREERTOS_KERNEL_PATH")\n`;
    out += `endif()\n`;
    out += `set(FA_FREERTOS_PORT \${FREERTOS_KERNEL_PATH}/portable/GCC/${core.port})   # ${core.label}\n\n`;
    out += `add_executable(${name}\n`;
    out += `    ${appFileName(app, 'main.cpp')}                           # generated (Export Application)\n`;
    out += `    ${appFileName(app, 'app.cpp')}\n`;
    for (const s of list(t.sources)) out += `    ${cmakePath(s)}\n`;
    if ((t.startup || '').trim()) out += `    ${cmakePath(t.startup!)}\n`;
    for (const k of ['tasks.c', 'queue.c', 'list.c']) out += `    \${FREERTOS_KERNEL_PATH}/${k}\n`;
    for (const k of core.portSources) out += `    \${FA_FREERTOS_PORT}/${k}\n`;
    out += `)\nset_target_properties(${name} PROPERTIES SUFFIX ".elf")\n\n`;
    out += `target_include_directories(${name} PRIVATE\n`;
    out += `    \${CMAKE_CURRENT_SOURCE_DIR}                 # generated and your headers, FreeRTOSConfig.h\n`;
    out += `    \${CMAKE_CURRENT_SOURCE_DIR}/freeactors      # the FreeActors library\n`;
    for (const i of list(t.includes)) out += `    ${cmakePath(i)}\n`;
    out += `    \${FREERTOS_KERNEL_PATH}/include\n    \${FA_FREERTOS_PORT}\n)\n\n`;
    if (list(t.defines).length > 0) out += `target_compile_definitions(${name} PRIVATE ${list(t.defines).join(' ')})\n\n`;
    out += `# FreeActors' features (trace, commands, health) come from ${appFileName(app, 'config.hpp')}, set in the diagram\n`;
    out += `set(FA_MCU_FLAGS ${core.flags.join(' ')})\n`;
    out += `target_compile_options(${name} PRIVATE\n    \${FA_MCU_FLAGS}\n    -Os -g3 -ffunction-sections -fdata-sections -Wall\n`;
    out += `    $<$<COMPILE_LANGUAGE:CXX>:-fno-exceptions -fno-rtti -fno-threadsafe-statics -fno-use-cxa-atexit>\n)\n`;
    out += `target_compile_features(${name} PRIVATE cxx_std_17)\n\n`;
    out += `target_link_options(${name} PRIVATE\n    \${FA_MCU_FLAGS}\n`;
    if ((t.linker_script || '').trim()) out += `    -T${cmakePath(t.linker_script!)}\n`;
    out += `    --specs=nano.specs --specs=nosys.specs\n    -Wl,--gc-sections\n    -Wl,-Map=\${CMAKE_CURRENT_BINARY_DIR}/${name}.map\n    -Wl,--print-memory-usage\n)\n\n`;
    out += `add_custom_command(TARGET ${name} POST_BUILD\n`;
    out += `    COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${name}> \${CMAKE_CURRENT_BINARY_DIR}/${name}.bin\n`;
    out += `    COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:${name}> \${CMAKE_CURRENT_BINARY_DIR}/${name}.hex\n`;
    out += `    COMMAND \${CMAKE_SIZE} $<TARGET_FILE:${name}>\n    COMMENT "${name}.bin, ${name}.hex"\n)\n`;
    if ((t.flash || '').trim()) {
        const args = splitCommand(t.flash!).map(a => a
            .replace(/\{elf\}/g, `$<TARGET_FILE:${name}>`)
            .replace(/\{bin\}/g, `\${CMAKE_CURRENT_BINARY_DIR}/${name}.bin`)
            .replace(/\{hex\}/g, `\${CMAKE_CURRENT_BINARY_DIR}/${name}.hex`));
        out += `\n# Program the board: ${t.flash!.trim()}\n`;
        out += `add_custom_target(flash\n    COMMAND ${args.map(a => (/[\s;"]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}\n`;
        out += `    DEPENDS ${name}\n    USES_TERMINAL\n)\n`;
    }
    return out;
}

// The highest task priority in the application (actors, periodic modules, services; FreeActors' own tasks use 1)
function highestPriority(app: any): number {
    return Math.max(1, ...((app.components || []) as any[]).filter(c => Number(c.priority) > 0).map(c => Number(c.priority)));
}

export function generateFreeRTOSConfig(app: any): string {
    const t = targetOf(app);
    const core = t.core || 'cortex-m4f';
    const bits = Number(t.nvic_prio_bits) > 0 ? Number(t.nvic_prio_bits) : 4;
    const maxSyscall = Number((app.settings || {}).MaxSyscallPriority ?? 5);
    const lines: [string, string, string?][] = [
        ['configCPU_CLOCK_HZ', '( SystemCoreClock )', 'CMSIS: the clock at scheduler start'],
        ['configTICK_RATE_HZ', `( ${Number(t.tick_hz) > 0 ? Number(t.tick_hz) : 1000} )`],
        ['configUSE_PREEMPTION', '1'],
        ['configUSE_PORT_OPTIMISED_TASK_SELECTION', '1'],
        ['configMAX_PRIORITIES', String(highestPriority(app) + 1), 'the highest priority in the diagram + 1'],
        ['configMINIMAL_STACK_SIZE', '128'],
        ['configMAX_TASK_NAME_LEN', '16'],
        ['configUSE_16_BIT_TICKS', '0'],
        ['configIDLE_SHOULD_YIELD', '1'],
        ['configSUPPORT_STATIC_ALLOCATION', '1', 'FreeActors allocates every task and queue statically'],
        ['configSUPPORT_DYNAMIC_ALLOCATION', '0'],
        ['configUSE_IDLE_HOOK', '0'],
        ['configUSE_TICK_HOOK', '1', 'drives Fa::Application::on_tick_isr() (timers)'],
        ['configUSE_MUTEXES', '0'],
        ['configUSE_TIMERS', '0', 'FreeActors\' timers run from the tick hook'],
        ['configQUEUE_REGISTRY_SIZE', '0'],
        ['configCHECK_FOR_STACK_OVERFLOW', '2', 'vApplicationStackOverflowHook (generated) and the board\'s on_stack_overflow'],
        ['configUSE_MALLOC_FAILED_HOOK', '0'],
        ['INCLUDE_vTaskDelay', '1'],
        ['INCLUDE_xTaskDelayUntil', '1'],
        ['INCLUDE_vTaskSuspend', '1'],
        ['INCLUDE_uxTaskGetStackHighWaterMark', '1', 'free stack per task (fa-trace "health")'],
        ['configPRIO_BITS', String(bits), 'the device\'s NVIC priority bits (__NVIC_PRIO_BITS)'],
        ['configLIBRARY_LOWEST_INTERRUPT_PRIORITY', String((1 << bits) - 1)],
        ['configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY', String(maxSyscall), 'interrupt modules use this priority or less urgent'],
        ['configKERNEL_INTERRUPT_PRIORITY', '( configLIBRARY_LOWEST_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )'],
        ['configMAX_SYSCALL_INTERRUPT_PRIORITY', '( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )'],
    ];
    if (core === 'cortex-m33') {
        lines.push(['configENABLE_FPU', '1'], ['configENABLE_MPU', '0'], ['configENABLE_TRUSTZONE', '0'],
                   ['configRUN_FREERTOS_SECURE_ONLY', '1', 'ARM_CM33_NTZ: no TrustZone'], ['configENABLE_MVE', '0']);
    }
    let out = `/* ==========================================================================\n`;
    out += ` * AUTO-GENERATED FREERTOS CONFIGURATION - DO NOT HAND-EDIT (from ${app.name}.app.json: the diagram and the\n`;
    out += ` * board's Target, Export Application). To change a value, define it in ${FREERTOS_USER_CONFIG_FILENAME} (yours):\n`;
    out += ` * it is included first, and every value below is only a default.\n`;
    out += ` * ========================================================================== */\n\n`;
    out += `#ifndef FREERTOS_CONFIG_H\n#define FREERTOS_CONFIG_H\n\n`;
    out += `#include "${FREERTOS_USER_CONFIG_FILENAME}"\n\n`;
    out += `#if defined(__GNUC__) && !defined(__ASSEMBLER__)\n#include <stdint.h>\n#ifdef __cplusplus\nextern "C" {\n#endif\n`;
    out += `extern uint32_t SystemCoreClock;   /* CMSIS (the vendor's system_<device>.c) */\n#ifdef __cplusplus\n}\n#endif\n#endif\n\n`;
    for (const [key, value, comment] of lines) {
        out += `#ifndef ${key}\n#define ${key} ${value}${comment ? `   /* ${comment} */` : ''}\n#endif\n`;
    }
    out += `\n/* A failed assertion stops here with interrupts off: attach the debugger to see where */\n`;
    out += `#ifndef configASSERT\n#define configASSERT( x )    if( ( x ) == 0 ) { taskDISABLE_INTERRUPTS(); for( ;; ) {} }\n#endif\n\n`;
    out += `/* FreeRTOS's handlers under the CMSIS names of the vendor's vector table (and FreeActors' own table) */\n`;
    out += `#define vPortSVCHandler      SVC_Handler\n#define xPortPendSVHandler   PendSV_Handler\n#define xPortSysTickHandler  SysTick_Handler\n\n`;
    out += `#endif /* FREERTOS_CONFIG_H */\n`;
    return out;
}

export function generateFreeRTOSUserConfigStub(app: any): string {
    return `/* Your FreeRTOS settings for ${app.name} (created once by FreeActors; Export never overwrites it).\n` +
           ` * FreeRTOSConfig.h is generated from the application and includes this file first: a value defined here\n` +
           ` * replaces the generated default, e.g.\n` +
           ` *     #define configMINIMAL_STACK_SIZE 256\n */\n` +
           `#ifndef FREERTOS_CONFIG_USER_H\n#define FREERTOS_CONFIG_USER_H\n\n#endif\n`;
}

// The firmware build files Export Application writes when the board's Target names a core: tool-owned
// (CMakePresets.json only while it is FreeActors', see the provider)
export function generateFirmwareFiles(app: any): { [file: string]: string } {
    return {
        [FIRMWARE_CMAKE_FILENAME]: generateFirmwareCMake(app),
        [TOOLCHAIN_FILENAME]: generateToolchainFile(app),
        'FreeRTOSConfig.h': generateFreeRTOSConfig(app),
        'CMakePresets.json': generateCMakePresets(app),
    };
}

// ---- Vendor flavours: a vendor's SDK layout turned into the Target's fields and the vendor-side files --------

export const FLAVOURS: { [id: string]: string } = { 'stm32f4-hal': 'STM32F4 + HAL' };

export const STM32F4_SDK_REPOSITORIES = ['cmsis_core', 'cmsis_device_f4', 'stm32f4xx_hal_driver'];

// The board's vendor glue for the STM32 HAL (user-owned, created once): the HAL's time base is the RTOS tick
export function generateStm32HalGlue(app: any): string {
    return `// ==========================================================================\n` +
        `// ${app.board?.type || 'The board'}: the vendor glue that cannot live in the header (C functions the HAL calls,\n` +
        `// defined once). Created once by FreeActors (the STM32F4 + HAL flavour); this file is yours.\n` +
        `// FreeRTOS owns SysTick: the HAL's time base is the RTOS tick.\n` +
        `// ==========================================================================\n\n` +
        `#include "stm32f4xx_hal.h"\n\n#include "FreeRTOS.h"\n#include "task.h"\n\nextern "C" {\n\n` +
        `// The HAL must not reconfigure SysTick (FreeRTOS uses it); HAL_Init() calls this\n` +
        `HAL_StatusTypeDef HAL_InitTick(uint32_t /*TickPriority*/) {\n    return HAL_OK;\n}\n\n` +
        `uint32_t HAL_GetTick(void) {\n    return xTaskGetTickCount();\n}\n\n} // extern "C"\n`;
}

// A linker script for an STM32F4 (user-owned, created once): flash at 0x08000000, SRAM at 0x20000000, the symbols
// of ST's GCC startup files, and the .noinit section FreeActors' health monitor keeps its fault record in
export function generateStm32LinkerScript(part: string, flashKb: number, ramKb: number): string {
    return `/*\n * Linker script for ${part}: ${flashKb} KB flash, ${ramKb} KB SRAM. Created once by FreeActors (the STM32F4 + HAL\n` +
` * flavour); this file is yours. Section and symbol names match ST's GCC startup files (startup_*.s):\n` +
` * _estack, _sidata, _sdata, _edata, _sbss, _ebss. FreeActors allocates everything statically, so there is no heap;\n` +
` * the stack below is used by main() until the scheduler starts, and by interrupts afterwards (MSP).\n */\n\n` +
`ENTRY(Reset_Handler)\n\n_estack = ORIGIN(RAM) + LENGTH(RAM);   /* initial MSP: top of SRAM */\n_Min_Stack_Size = 0x800;               /* 2 KB */\n\n` +
`MEMORY\n{\n    FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = ${flashKb}K\n    RAM   (rwx) : ORIGIN = 0x20000000, LENGTH = ${ramKb}K\n}\n\n` +
`SECTIONS\n{\n` +
`    .isr_vector : { . = ALIGN(4); KEEP(*(.isr_vector)) . = ALIGN(4); } > FLASH\n\n` +
`    .text :\n    {\n        . = ALIGN(4);\n        *(.text) *(.text*) *(.glue_7) *(.glue_7t) *(.eh_frame)\n        KEEP(*(.init)) KEEP(*(.fini))\n        . = ALIGN(4);\n        _etext = .;\n    } > FLASH\n\n` +
`    .rodata : { . = ALIGN(4); *(.rodata) *(.rodata*) . = ALIGN(4); } > FLASH\n\n` +
`    .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } > FLASH\n` +
`    .ARM : { __exidx_start = .; *(.ARM.exidx*) __exidx_end = .; } > FLASH\n\n` +
`    .preinit_array : { PROVIDE_HIDDEN(__preinit_array_start = .); KEEP(*(.preinit_array*)) PROVIDE_HIDDEN(__preinit_array_end = .); } > FLASH\n` +
`    .init_array : { PROVIDE_HIDDEN(__init_array_start = .); KEEP(*(SORT(.init_array.*))) KEEP(*(.init_array*)) PROVIDE_HIDDEN(__init_array_end = .); } > FLASH\n` +
`    .fini_array : { PROVIDE_HIDDEN(__fini_array_start = .); KEEP(*(SORT(.fini_array.*))) KEEP(*(.fini_array*)) PROVIDE_HIDDEN(__fini_array_end = .); } > FLASH\n\n` +
`    _sidata = LOADADDR(.data);\n\n` +
`    .data : { . = ALIGN(4); _sdata = .; *(.data) *(.data*) . = ALIGN(4); _edata = .; } > RAM AT > FLASH\n\n` +
`    .bss :\n    {\n        . = ALIGN(4);\n        _sbss = .;\n        __bss_start__ = _sbss;\n        *(.bss) *(.bss*) *(COMMON)\n        . = ALIGN(4);\n        _ebss = .;\n        __bss_end__ = _ebss;\n    } > RAM\n\n` +
`    /* Not zeroed at start-up: survives a reset (FreeActors' health record, FA_NOINIT) */\n` +
`    .noinit (NOLOAD) : { . = ALIGN(4); *(.noinit) *(.noinit*) . = ALIGN(4); } > RAM\n\n` +
`    /* Fails the link if static data leaves less than _Min_Stack_Size for the main stack */\n` +
`    ._user_stack :\n    {\n        . = ALIGN(8);\n        PROVIDE(end = .);\n        PROVIDE(_end = .);\n        . = . + _Min_Stack_Size;\n        . = ALIGN(8);\n    } > RAM\n\n` +
`    .ARM.attributes 0 : { *(.ARM.attributes) }\n}\n`;
}

// The STM32F4 + HAL flavour: the Target's fields for the part (STM32F446xx) and the SDK folder holding ST's
// repositories cmsis_core, cmsis_device_f4 and stm32f4xx_hal_driver; the files it creates if missing (yours)
export function stm32f4HalFlavour(app: any): { target: Target; create: { [file: string]: string }; copy: { [file: string]: string } } {
    const t = targetOf(app);
    const part = (t.part || 'STM32F446xx').trim();
    const sdk = (t.sdk || 'third_party/st').trim().replace(/[\\/]+$/, '');
    const lowerPart = part.toLowerCase();
    const boardSource = String(app.board?.header || 'bsp_board.hpp').replace(/\.(hpp|h)$/, '.cpp');
    const linker = `firmware/${lowerPart}_flash.ld`;
    const hal = (m: string) => `${sdk}/stm32f4xx_hal_driver/Src/stm32f4xx_hal${m}.c`;
    const flavourSources = [boardSource, `${sdk}/cmsis_device_f4/Source/Templates/system_stm32f4xx.c`,
        ...['', '_cortex', '_rcc', '_rcc_ex', '_gpio', '_dma', '_dma_ex', '_pwr', '_pwr_ex', '_uart'].map(hal)];
    const flavourIncludes = [`${sdk}/cmsis_core/Core/Include`, `${sdk}/cmsis_device_f4/Include`, `${sdk}/stm32f4xx_hal_driver/Inc`, 'firmware'];
    const union = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b || [])])];
    return {
        target: {
            ...t, flavour: 'stm32f4-hal', part, sdk, core: 'cortex-m4f', nvic_prio_bits: 4,
            linker_script: linker, startup: `${sdk}/cmsis_device_f4/Source/Templates/gcc/startup_${lowerPart}.s`,
            sources: union(flavourSources, t.sources), includes: union(flavourIncludes, t.includes),
            defines: union([part, 'USE_HAL_DRIVER'], t.defines),
            flash: (t.flash || '').trim() || 'openocd -f interface/stlink.cfg -f target/stm32f4x.cfg -c "program {elf} verify reset exit"',
        },
        create: {
            [linker]: generateStm32LinkerScript(part, Number(t.flash_kb) > 0 ? Number(t.flash_kb) : 512, Number(t.ram_kb) > 0 ? Number(t.ram_kb) : 128),
            [boardSource]: generateStm32HalGlue(app),
        },
        copy: { 'firmware/stm32f4xx_hal_conf.h': `${sdk}/stm32f4xx_hal_driver/Inc/stm32f4xx_hal_conf_template.h` },
    };
}

// What a flavour adds to the board blueprint: the vendor's header, its start-up call, the device's interrupt count
export interface BoardFlavour { include: string; init: string; irqCount?: number; }

export function boardFlavourOf(app: any, deviceHeader?: string): BoardFlavour | undefined {
    if (targetOf(app).flavour !== 'stm32f4-hal') return undefined;
    // the device header's IRQn_Type: the last interrupt's number + 1 sizes the vector table
    const numbers = deviceHeader ? [...deviceHeader.matchAll(/^\s*\w+_IRQn\s*=\s*(\d+)\b/gm)].map(m => Number(m[1])) : [];
    const flavour: BoardFlavour = {
        include: '#include "stm32f4xx_hal.h"   // STM32F4 HAL and CMSIS (the STM32F4 + HAL flavour)',
        init: 'HAL_Init();   // flash prefetch and caches, NVIC priority grouping 4 (as FreeRTOS requires); the HAL\'s tick is the RTOS tick',
    };
    if (numbers.length > 0) flavour.irqCount = Math.max(...numbers) + 1;
    return flavour;
}

// The paths of the Target the checks look at (relative to the application's folder, or absolute)
export function targetPaths(app: any): string[] {
    const t = targetOf(app);
    return [...(t.sources || []), t.startup || '', t.linker_script || ''].map(s => s.trim()).filter(s => s && !s.includes('$'));
}

// The application-wide hardware contract: the board against every module's requirements at once
// (owners: the namespaces of the modules' HwRequirements, e.g. Timebomb, ButtonPoller)
export function generateAppHwContractString(appName: string, owners: string[]): string {
    const upper = appName.toUpperCase();
    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED APPLICATION HARDWARE CONTRACT - DO NOT HAND-EDIT (rewritten on every export)\n`;
    out += `// Application: ${appName}. The board must provide what every module requires:\n`;
    owners.forEach(o => { out += `//   ${o}: ${hwRequirementsFile(o.toLowerCase())}\n`; });
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n`;
    out += `#ifndef ${upper}_APP_HW_CONTRACT_HPP\n`;
    out += `#define ${upper}_APP_HW_CONTRACT_HPP\n\n`;
    owners.forEach(o => { out += `#include "${o.toLowerCase()}_hw_contract.hpp"\n`; });
    out += `\nnamespace App {\n\n`;
    out += `template <typename Board>\n`;
    out += `struct HwContract {\n`;
    out += `    static constexpr bool verify() {\n`;
    out += `        return true${owners.map(o => `\n            && ::${o}::HwContract<Board>::verify()`).join('')};\n`;
    out += `    }\n`;
    out += `};\n\n`;
    out += `} // namespace App\n\n`;
    out += `#endif // ${upper}_APP_HW_CONTRACT_HPP\n`;
    return out;
}

// ==========================================================================
// APPLICATION GENERATION (docs/design/app-diagram.md, section 4): tool-owned files from <app>.app.json
//   <app>_config.hpp    features (FA_TRACE...) and each component's values from the diagram (AppConfig::<Name>)
//   <app>_app.hpp       the board, actors and modules, AppTraits, task settings, App::Application
//   <app>_app.cpp       FreeRTOS hooks and app_start()
//   <app>_main.cpp      int main() { app_start(); }
//   <app>_app_hw_contract.hpp  the board against every module's hardware requirements
// ==========================================================================
const MODULE_KINDS = ['periodic', 'interrupt', 'spsc', 'mpsc', 'dma'];
const TASK_KINDS = ['periodic', 'spsc', 'mpsc', 'dma'];      // modules with a task of their own

export const appFileName = (app: any, suffix: string) =>
    `${String(app.name || 'App').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()}_${suffix}`;
// The user-owned file of a periodic module, interrupt module or service (its template App::<Name>)
export const moduleFileName = (name: string) => `${String(name).toLowerCase()}_module.hpp`;

function appComponents(app: any): any[] {
    return (Array.isArray(app.components) ? app.components : []).filter((c: any) => !COMPOSITE_KINDS.includes(c.kind));
}

export function generateAppConfigString(app: any): string {
    const features = app.features || {};
    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED APPLICATION CONFIGURATION - DO NOT HAND-EDIT (from ${appFileName(app, '').slice(0, -1)}.app.json)\n`;
    out += `// The features and every component's values as set in the application diagram. Module files read their\n`;
    out += `// values from here (e.g. AppConfig::ButtonPoller::period_ms), so a change in the diagram reaches the code.\n`;
    out += `// Include this file before any FreeActors header (the features below switch framework code).\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n#include <cstddef>\n#include <cstdint>\n\n`;
    const switches: [boolean, string][] = [[features.trace, 'FA_TRACE'], [features.commands, 'FA_TRACE_COMMANDS'],
                                           [features.health, 'FA_HEALTH'], [features.debug_commands, 'FA_DEBUG_COMMANDS']];
    out += `// ---- Features ----\n`;
    switches.forEach(([on, name]) => {
        out += on ? `#ifndef ${name}\n#define ${name}\n#endif\n` : `// ${name}: off\n`;
    });
    out += `\nnamespace AppConfig {\n\n`;
    for (const c of appComponents(app)) {
        out += `struct ${c.name} {   // ${c.kind}\n`;
        if (c.kind === 'actor') {
            out += `    static constexpr unsigned priority = ${Number(c.priority) || 2};\n`;
            out += `    static constexpr size_t queue = ${Number(c.queue) || 8};\n`;
            out += `    static constexpr size_t stack = ${Number(c.stack) || 128};\n`;
        } else if (c.kind === 'interrupt') {
            out += `    static constexpr uint32_t pri = ${Number(c.pri) || 0};\n`;
        } else {
            if (c.kind === 'periodic') out += `    static constexpr size_t period_ms = ${Number(c.period_ms) || 1};\n`;
            if (SERVICE_KINDS.includes(c.kind)) out += `    static constexpr size_t size = ${Number(c.size) || 1};\n`;
            out += `    static constexpr unsigned priority = ${Number(c.priority) || 1};\n`;
            out += `    static constexpr size_t stack = ${Number(c.stack) || 128};\n`;
        }
        out += `};\n`;
    }
    out += `\n} // namespace AppConfig\n`;
    return out;
}

export function generateAppHeaderString(app: any, models: AppModelInfo[]): string {
    const components = appComponents(app);
    const actorMachine = (c: any) => (models.find(m => m.file === c.model) || { name: c.name }).name;
    const config = appFileName(app, 'config.hpp');
    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED APPLICATION - DO NOT HAND-EDIT (rewritten on every export of the application)\n`;
    out += `// The board, the components and their task settings, as drawn in the application diagram.\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n\n`;
    out += `#include "${config}"\n`;
    out += `#define FA_APP_MANAGED   // task settings come from here, not from the actor headers' defaults\n\n`;
    if (app.board && app.board.header) out += `#include "${app.board.header}"\n`;
    components.filter(c => c.kind === 'actor').forEach(c => { out += `#include "${actorMachine(c).toLowerCase()}_actor.hpp"\n`; });
    components.filter(c => MODULE_KINDS.includes(c.kind)).forEach(c => { out += `#include "${moduleFileName(c.name)}"\n`; });
    out += `#include "fa_app.hpp"\n\n`;

    out += `namespace App {\n\n`;
    out += `struct Traits : Fa::DefaultAppTraits {\n`;
    out += `    using Platform = ${(app.board && app.board.type) || 'Board'};\n`;
    for (const [key, value] of Object.entries(app.settings || {})) {
        if (key === 'MaxSyscallPriority') continue;              // a check of the diagram, not a framework setting
        if (typeof value === 'number') out += `    static constexpr ${key.endsWith('Ms') ? 'uint32_t' : 'size_t'} ${key} = ${value};\n`;
    }
    out += `};\n\n} // namespace App\n\n`;
    out += `// The board provides what every module requires (${appFileName(app, 'app_hw_contract.hpp')})\n`;
    out += `#include "${appFileName(app, 'app_hw_contract.hpp')}"\n`;
    out += `static_assert(App::HwContract<App::Traits::Platform>::verify());\n\n`;

    out += `// ---- Task settings (from the diagram) ----\nnamespace Fa {\n\n`;
    components.filter(c => c.kind === 'actor').forEach(c => {
        const m = actorMachine(c);
        out += `template <typename Hw, typename Ctx>\n`;
        out += `struct ActorTraits<${m}::Actor<Hw, Ctx>> {\n`;
        out += `    static constexpr size_t QueueLength     = AppConfig::${c.name}::queue;\n`;
        out += `    static constexpr size_t StackDepthWords = AppConfig::${c.name}::stack;\n`;
        out += `    static constexpr unsigned Priority      = AppConfig::${c.name}::priority;\n`;
        out += `    static constexpr const char* Name       = "${c.name}";\n`;
        out += `};\n\n`;
    });
    components.filter(c => TASK_KINDS.includes(c.kind)).forEach(c => {
        out += `template <typename Hw, typename Ctx>\n`;
        out += `struct TimeServiceTraits<App::${c.name}<Hw, Ctx>> {\n`;
        out += `    static constexpr const char* name     = "${c.name}";\n`;
        out += `    static constexpr size_t stack_size    = AppConfig::${c.name}::stack;\n`;
        out += `    static constexpr UBaseType_t priority = AppConfig::${c.name}::priority;\n`;
        out += `};\n\n`;
    });
    out += `} // namespace Fa\n\n`;

    const list = components.map(c => c.kind === 'actor' ? `${actorMachine(c)}::Actor` : c.name);
    out += `namespace App {\n\n`;
    out += `using Application = Fa::Application<Traits${list.map(x => `,\n    ${x}`).join('')}>;\n\n`;
    out += `} // namespace App\n\n`;
    out += `// Board init, tasks, scheduler (${appFileName(app, 'app.cpp')}); does not return\n`;
    out += `void app_start();\n`;
    if (app.settings && app.settings.on_init) out += `// Yours (${appFileName(app, 'on_init.cpp')}): code outside FreeActors, before the scheduler starts\nvoid app_on_init();\n`;
    return out;
}

export function generateAppSourceString(app: any): string {
    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED APPLICATION START-UP - DO NOT HAND-EDIT\n`;
    out += `// The FreeRTOS hooks every FreeActors application needs, and app_start().\n`;
    out += `// Vendor start-up (HAL/SDK init, clocks) belongs to the board's init(), which app_start() calls first.\n`;
    out += `// ==========================================================================\n\n`;
    out += `#include "${appFileName(app, 'app.hpp')}"\n\n`;
    out += `#include <type_traits>\n\n`;
    out += `namespace {\n`;
    out += `    // Optional board hook: static void on_stack_overflow(char const* task) noexcept, e.g. a red LED\n`;
    out += `    template <typename B, typename = void> struct has_overflow_hook : std::false_type {};\n`;
    out += `    template <typename B> struct has_overflow_hook<B, std::void_t<decltype(B::on_stack_overflow(nullptr))>> : std::true_type {};\n`;
    out += `    template <typename B> void report_stack_overflow(char *task) {   // a template: the hook is optional\n`;
    out += `        if constexpr (has_overflow_hook<B>::value) B::on_stack_overflow(task); else (void)task;\n`;
    out += `    }\n`;
    out += `}\n\n`;
    out += `extern "C" {\n\n`;
    out += `// Every RTOS tick: FreeActors timers (and interrupt-free tick hooks of modules)\n`;
    out += `void vApplicationTickHook(void) {\n    App::Application::on_tick_isr();\n}\n\n`;
    out += `// Static memory for the idle task (configSUPPORT_STATIC_ALLOCATION = 1)\n`;
    out += `void vApplicationGetIdleTaskMemory(StaticTask_t **tcb, StackType_t **stack, configSTACK_DEPTH_TYPE *size) {\n`;
    out += `    static StaticTask_t idle_tcb;\n    static StackType_t idle_stack[configMINIMAL_STACK_SIZE];\n`;
    out += `    *tcb = &idle_tcb;\n    *stack = idle_stack;\n    *size = configMINIMAL_STACK_SIZE;\n}\n\n`;
    out += `#if configUSE_TIMERS\n`;
    out += `// Static memory for the FreeRTOS timer task (FreeActors itself does not use it)\n`;
    out += `void vApplicationGetTimerTaskMemory(StaticTask_t **tcb, StackType_t **stack, configSTACK_DEPTH_TYPE *size) {\n`;
    out += `    static StaticTask_t timer_tcb;\n    static StackType_t timer_stack[configTIMER_TASK_STACK_DEPTH];\n`;
    out += `    *tcb = &timer_tcb;\n    *stack = timer_stack;\n    *size = configTIMER_TASK_STACK_DEPTH;\n}\n#endif\n\n`;
    out += `// configCHECK_FOR_STACK_OVERFLOW: stop; the board may show it (on_stack_overflow), the debugger shows pcTaskName\n`;
    out += `void vApplicationStackOverflowHook(TaskHandle_t, char *pcTaskName) {\n`;
    out += `    taskDISABLE_INTERRUPTS();\n`;
    out += `    report_stack_overflow<App::Traits::Platform>(pcTaskName);\n`;
    out += `    for (;;) {}\n}\n\n`;
    out += `} // extern "C"\n\n`;
    out += `void app_start() {\n`;
    out += `    App::Application::init();    // the board's init() (vendor start-up), vector table, tasks and queues\n`;
    if (app.settings && app.settings.on_init) out += `    app_on_init();               // yours: code outside FreeActors\n`;
    out += `    App::Application::start();   // the scheduler; does not return\n`;
    out += `}\n`;
    return out;
}

export function generateAppMainString(app: any): string {
    return `// AUTO-GENERATED - DO NOT HAND-EDIT. The firmware's entry point: everything starts in app_start()\n` +
           `// (${appFileName(app, 'app.cpp')}); vendor start-up is the board's init().\n` +
           `#include "${appFileName(app, 'app.hpp')}"\n\n` +
           `int main() {\n    app_start();\n}\n`;
}

// ---- Module skeletons (user-owned, created once) ----------------------------------------------------------

// What an interrupt module's outgoing connection asks of its acknowledge function
function interruptAck(app: any, c: any, models: AppModelInfo[]):
        { returnType: string; handler: string; includes: string[] } {
    const conns = (app.connections || []).filter((x: any) => x.from === c.id);
    const byId = (id: string) => (app.components || []).find((x: any) => x.id === id);
    const ack = `${c.irq || 'irq'}_ack`;
    if (c.commands) {   // receives the PC's commands for the built-in command service (FA_TRACE_COMMANDS)
        return { returnType: 'size_t', includes: [],
                 handler: `        IsrCtx::command_rx(Hw::${ack}());                 // where the receive DMA has written up to\n` };
    }
    const first = conns[0];
    const target = first ? byId(first.to) : undefined;
    if (first && first.kind === 'stream' && target) {
        return { returnType: 'size_t', includes: [moduleFileName(target.name)],   // the ring's template, named below
                 handler: `        IsrCtx::template stream<${target.name}>(Hw::${ack}());   // where the DMA has written up to\n` };
    }
    if (first && first.kind === 'item' && target) {
        const item = first.item || target.item || 'uint32_t';
        return { returnType: isBuiltinItemType(item) ? item : `App::${item}`, includes: isBuiltinItemType(item) ? [] : [moduleFileName(target.name)],
                 handler: `        IsrCtx::push(Hw::${ack}());                       // the item, to ${target.name}\n` };
    }
    if (first && first.kind === 'event' && target && target.kind === 'actor') {
        const machine = (models.find(m => m.file === target.model) || { name: target.name }).name;
        const event = (first.events || [])[0] || 'Event';
        return { returnType: 'bool', includes: [`${machine.toLowerCase()}_events.hpp`],
                 handler: `        if (Hw::${ack}()) {                               // it was ours\n` +
                          `            IsrCtx::post(${machine}::${event}{});\n        }\n` };
    }
    return { returnType: 'bool', includes: [], handler: `        if (Hw::${ack}()) {\n            // IsrCtx::post(...), IsrCtx::push(...)\n        }\n` };
}

// The requirements a new module starts with: for an interrupt module, its interrupt and acknowledge function
export function generateModuleRequirementsStub(app: any, c: any, models: AppModelInfo[]): string {
    const kind = c.kind === 'interrupt' ? 'interrupt' : c.kind === 'periodic' ? 'periodic' : 'service';
    let out = generateCppHwRequirementsStub(c.name, kind);
    if (c.kind === 'interrupt' && c.irq) {
        const ack = interruptAck(app, c, models);
        out = out.replace(/struct HwRequirements \{\n[\s\S]*?\n\};/,
            `struct HwRequirements {\n` +
            `    struct Irq {\n        static const int ${c.irq};   // the board: struct Irq { static constexpr IRQn_Type ${c.irq} = ...; };\n    };\n` +
            `    static ${ack.returnType} ${c.irq}_ack();   // acknowledge the interrupt (clear its flag)` +
            (ack.returnType === 'bool' ? '; true = it was ours' : ack.returnType === 'size_t' ? ' and return the DMA write position' : ' and return the item') +
            `\n};`);
        if (!/#include <cstddef>/.test(out)) out = out.replace('#include <cstdint>\n', '#include <cstddef>\n#include <cstdint>\n');
        // an item type of the application's (declared by the service it goes to): named here, defined there
        const custom = /^App::(\w+)$/.exec(ack.returnType);
        if (custom) out = out.replace(`namespace ${c.name} {`, `namespace App { struct ${custom[1]}; }   // declared in the service's module file\n\nnamespace ${c.name} {`);
    }
    return out;
}

// The module's API block: Hw for the board, and under FA_IDE (clangd only) its requirements for completion
function moduleApiBlock(name: string): string {
    return `#ifdef FA_IDE\n    using Hw = ::${name}::HwRequirements;   // seen only by the IDE: completion of what this module requires\n` +
           `#else\n    using Hw = HwPolicy;\n#endif\n` +
           `    static_assert(::${name}::HwContract<HwPolicy>::verify());   // the board provides what this module requires\n`;
}

// Item types the language provides; any other type named on a service (LogLine) is declared by the service
export function isBuiltinItemType(type: string): boolean {
    const t = String(type).trim();
    return /^(u?int(8|16|32|64)_t|u?int_(least|fast)(8|16|32|64)_t|size_t|bool|char|float|double|(unsigned |signed )?(char|short|int|long|long long))$/.test(t) ||
           t.includes('::') || t.includes('<') || t.endsWith('*');
}

export function generateModuleSkeleton(app: any, c: any, models: AppModelInfo[]): string {
    const lower = String(c.name).toLowerCase();
    const config = appFileName(app, 'config.hpp');
    const conns = (app.connections || []).filter((x: any) => x.from === c.id);
    const byId = (id: string) => (app.components || []).find((x: any) => x.id === id);
    const eventIncludes = new Set<string>();
    const examples: string[] = [];
    for (const conn of conns) {
        const target = byId(conn.to);
        if (!target) continue;
        if (conn.kind === 'event' && target.kind === 'actor') {
            const machine = (models.find(m => m.file === target.model) || { name: target.name }).name;
            eventIncludes.add(`${machine.toLowerCase()}_events.hpp`);
            for (const e of conn.events || []) examples.push(`Ctx::post(${machine}::${e}{});`);
        } else if (conn.kind === 'item') {
            const item = conn.item || target.item || 'uint32_t';
            if (!isBuiltinItemType(item)) eventIncludes.add(moduleFileName(target.name));   // the service declares it
            examples.push(`Ctx::${target.kind === 'spsc' ? 'spsc' : 'mpsc'}_push(${item}{});   // to ${target.name}`);
        }
    }
    const isr = c.kind === 'interrupt' ? interruptAck(app, c, models) : undefined;
    isr?.includes.forEach(i => eventIncludes.add(i));

    let out = `// ==========================================================================\n`;
    out += `// ${String(KIND_TITLES[c.kind] || c.kind).toUpperCase()} - ${c.name}\n`;
    out += `// Created once by FreeActors; this file is yours to edit (Export never overwrites it).\n`;
    out += `// Its settings (period, priority, stack, ...) come from the application diagram: AppConfig::${c.name} in ${config}.\n`;
    out += `// What it needs from the board: ${hwRequirementsFile(lower)} (checked by ${lower}_hw_contract.hpp).\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n\n`;
    out += `#include "${config}"\n`;
    out += `#include "${c.kind === 'interrupt' ? 'fa_interrupt.hpp' : 'fa_freertos.hpp'}"\n`;
    out += `#include "${lower}_hw_contract.hpp"\n`;
    eventIncludes.forEach(i => { out += `#include "${i}"\n`; });
    out += `\nnamespace App {\n\n`;

    if (c.kind === 'periodic') {
        out += `template <typename HwPolicy, typename Ctx>\n`;
        out += `struct ${c.name} : Fa::TimeServiceInterface<${c.name}<HwPolicy, Ctx>, AppConfig::${c.name}::period_ms> {\n`;
        out += moduleApiBlock(c.name) + `\n`;
        out += `    // Runs every AppConfig::${c.name}::period_ms milliseconds, in this module's own task\n`;
        out += `    static void task() noexcept {\n`;
        out += examples.length > 0 ? examples.map(e => `        // ${e}\n`).join('') : `        // e.g. read the board (Hw::...) and post events: Ctx::post(Machine::Event{});\n`;
        out += `    }\n`;
        out += `\nprivate:\n    // State kept between iterations, e.g.: static inline bool last = false;\n`;
    } else if (c.kind === 'interrupt') {
        out += `template <typename HwPolicy, typename IsrCtx>\n`;
        out += `struct ${c.name} : Fa::InterruptInterface<${c.name}<HwPolicy, IsrCtx>> {\n`;
        out += moduleApiBlock(c.name) + `\n`;
        out += `    static constexpr auto IRQNum = Hw::Irq::${c.irq || 'irq'};          // which interrupt: the board's\n`;
        out += `    static constexpr uint32_t PRI = AppConfig::${c.name}::pri;   // its priority: from the diagram\n\n`;
        out += `    // Runs in the interrupt: keep it short. IsrCtx offers only what an interrupt may do (post, push, stream).\n`;
        out += `    static void handler() {\n${isr!.handler}    }\n`;
    } else {
        const element = c.kind === 'dma' ? (c.element || 'uint8_t') : (c.item || 'uint32_t');
        const base = c.kind === 'spsc' ? 'SpscServiceInterface' : c.kind === 'mpsc' ? 'MpscServiceInterface' : 'DmaRingInterface';
        if (!isBuiltinItemType(element)) {
            // The service owns its item type (one source of truth, as an actor owns its events): producers include this file
            out += `// What ${c.name}'s producers push and consume_batch() receives: add its fields, with default values.\n`;
            out += `// Items are copied into the buffer (and may come from interrupts): keep them small and plain.\n`;
            out += `struct ${element} {\n    // e.g. uint32_t code = 0;\n};\n\n`;
        }
        out += `template <typename HwPolicy, typename Ctx>\n`;
        out += `struct ${c.name} : Fa::${base}<${c.name}<HwPolicy, Ctx>, ${element}, AppConfig::${c.name}::size> {\n`;
        out += moduleApiBlock(c.name) + `\n`;
        if (c.kind === 'dma') {
            out += `    using Base = Fa::${base}<${c.name}<HwPolicy, Ctx>, ${element}, AppConfig::${c.name}::size>;\n\n`;
            out += `    // Once, in this service's task, before data flows: start the board's circular DMA into Base::buffer()\n`;
            out += `    static void on_start() noexcept {\n        // e.g. Hw::${String(c.name).toLowerCase()}_start(Base::buffer(), Base::size);\n    }\n\n`;
            out += `    // Data the DMA wrote, in place (at most two spans per wake-up: the ring wraps)\n`;
            out += `    static void consume_batch(${element} const* data, size_t n) noexcept {\n        (void)data; (void)n;\n`;
            out += `        // if (!Base::span_intact()) { ... }   // the DMA overwrote this span while it was read\n    }\n`;
        } else {
            out += `    // Items pushed by its producer${c.kind === 'spsc' ? ' (exactly one)' : 's'}, in this service's task, in order\n`;
            out += `    static void consume_batch(${element} const* items, size_t n) noexcept {\n        (void)items; (void)n;\n`;
            out += examples.length > 0 ? examples.map(e => `        // ${e}\n`).join('') : `        // e.g. process the items, then Ctx::post(Machine::Result{...});\n`;
            out += `    }\n`;
        }
    }
    out += `};\n\n} // namespace App\n`;
    return out;
}

const KIND_TITLES: { [k: string]: string } = {
    periodic: 'Periodic module', interrupt: 'Interrupt module', spsc: 'SPSC service', mpsc: 'MPSC service', dma: 'DMA ring service',
};

// ---- Board blueprint (user-owned board file: created once, missing members appended on later exports) -----

export interface RequirementSource { owner: string; content: string; }

interface BoardMember { key: string; code: string; owners: string[]; section: string; }

// The comment written next to a declaration in a requirements file, e.g. "LD2: armed / ticking"
function requirementComment(content: string, name: string): string {
    const m = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*;\\s*//\\s*(.*)$`, 'm').exec(content);
    return m && m[1] ? m[1].trim() : '';
}

function stubBody(returnType: string, params: string): string {
    const names = params.split(',').map(p => p.trim().split(/\s+/).pop() || '').filter(n => /^[A-Za-z_]\w*$/.test(n));
    const unused = names.length > 0 ? names.map(n => `(void)${n}; `).join('') : '';
    return returnType === 'void' ? `{ ${unused}/* TODO */ }` : `{ ${unused}return {}; /* TODO */ }`;
}

// Everything the application's board must provide: the modules' requirements and the enabled features' functions
function boardMembers(app: any, sources: RequirementSource[]): { members: BoardMember[]; irqs: { name: string; owners: string[] }[] } {
    const members: BoardMember[] = [];
    const add = (key: string, code: string, owner: string, section: string) => {
        const existing = members.find(m => m.key === key);
        if (existing) { if (!existing.owners.includes(owner)) existing.owners.push(owner); return; }
        members.push({ key, code, owners: [owner], section });
    };
    const features = app.features || {};
    add('init', 'static void init() { /* TODO: vendor start-up (HAL/SDK init), clock tree, then each peripheral below */ }',
        'FreeActors', 'START-UP');
    for (const s of sources) {
        for (const m of parseHwRequirementsHeader(s.content)) {
            if (m.name === 'init') continue;
            const comment = requirementComment(s.content, m.name);
            add(m.name, `static ${m.returnType} ${m.name}(${m.rawArgs}) ${stubBody(m.returnType, m.rawArgs)}${comment ? `   // ${comment}` : ''}`,
                s.owner, 'DRIVERS');
        }
    }
    if (features.trace) {
        add('trace_write', 'static void trace_write(uint8_t const* data, size_t n) noexcept { (void)data; (void)n; /* TODO: send the bytes (UART, RTT); may block */ }', 'trace', 'TRACE (FA_TRACE)');
        add('trace_timestamp', 'static uint32_t trace_timestamp() noexcept { return 0; /* TODO: e.g. Fa::CortexM::CycleCounter::now() */ }', 'trace', 'TRACE (FA_TRACE)');
        add('trace_timestamp_hz', 'static uint32_t trace_timestamp_hz() noexcept { return 1; /* TODO: the timestamp clock, e.g. SystemCoreClock */ }', 'trace', 'TRACE (FA_TRACE)');
    }
    if (features.commands) {
        add('rx_stream_start', 'static void rx_stream_start(uint8_t* buffer, size_t n) noexcept { (void)buffer; (void)n; /* TODO: circular receive DMA into buffer; its interrupt modules call IsrCtx::command_rx(position) */ }',
            'commands', 'COMMANDS (FA_TRACE_COMMANDS)');
    }
    if (features.health) {
        add('watchdog_start', 'static void watchdog_start(uint32_t timeout_ms) noexcept { (void)timeout_ms; /* TODO: start the hardware watchdog (it cannot be stopped) */ }', 'health', 'WATCHDOG (FA_HEALTH)');
        add('watchdog_kick', 'static void watchdog_kick() noexcept { /* TODO: feed the watchdog */ }', 'health', 'WATCHDOG (FA_HEALTH)');
        add('reset_cause', 'static Fa::ResetCause reset_cause() noexcept { return Fa::ResetCause::Unknown; /* TODO: from the reset flags, read once in init() */ }', 'health', 'WATCHDOG (FA_HEALTH)');
    }
    if (features.debug_commands) {
        add('reset', 'static void reset() noexcept { /* TODO: e.g. Fa::CortexM::system_reset(); */ }', 'debug commands', 'RESET (FA_DEBUG_COMMANDS)');
    }
    const irqs: { name: string; owners: string[] }[] = [];
    for (const s of sources) {
        for (const name of parseIrqRequirements(s.content)) {
            const existing = irqs.find(i => i.name === name);
            if (existing) existing.owners.push(s.owner); else irqs.push({ name, owners: [s.owner] });
        }
    }
    return { members, irqs };
}

const SECTION_GUIDANCE: { [s: string]: string } = {
    'START-UP': 'Called first by app_start(), before any task: the vendor\'s start-up and the peripherals used below.',
    'INTERRUPTS': 'Which interrupt delivers each source the application needs (CMSIS IRQn_Type from the device header).\n' +
                  '// Only the number: FreeActors installs the handler, sets the priority (chosen by the interrupt module) and enables it.\n' +
                  '// Configure each peripheral in init(); acknowledge each interrupt in its *_ack function (clear the flag).',
    'DRIVERS': 'What the modules require (their *_hw_requirements.hpp), checked at compile time by the contracts.',
    'TRACE (FA_TRACE)': 'The trace transport, called from the trace task (lowest priority).',
    'COMMANDS (FA_TRACE_COMMANDS)': 'Command input from the PC: start continuous reception into the given buffer.',
    'WATCHDOG (FA_HEALTH)': 'The hardware watchdog, fed by the health monitor only while every task is healthy.',
    'RESET (FA_DEBUG_COMMANDS)': 'The RESET command from the PC.',
};

function memberLines(m: BoardMember): string {
    const by = m.owners.filter(o => !['FreeActors', 'trace', 'commands', 'health', 'debug commands'].includes(o));
    return (by.length > 0 ? `    // required by ${by.join(', ')}\n` : '') + `    ${m.code}\n`;
}

// A member added to an existing board: its requirement comment, if any, becomes the TODO's text
function markAdded(code: string): string {
    const at = code.indexOf('   // ');
    return at < 0 ? `    ${code}   // TODO (added by export)`
                  : `    ${code.slice(0, at)}   // TODO (added by export): ${code.slice(at + 6)}`;
}

// placeholder: a distinct number per interrupt (two modules on one interrupt would not compile)
function irqLine(i: { name: string; owners: string[] }, placeholder: number): string {
    return `        static constexpr int ${i.name} = ${placeholder};   // TODO: the device's IRQn_Type, e.g. USART3_IRQn (required by ${i.owners.join(', ')})\n`;
}

// The board's struct name and namespace from AppTraits::Platform, e.g. Board::NucleoF446ZE
function boardTypeParts(app: any): { ns: string | undefined; name: string } {
    const parts = String((app.board && app.board.type) || 'Board::MyBoard').split('::');
    return { name: parts.pop() || 'MyBoard', ns: parts.length > 0 ? parts.join('::') : undefined };
}

export function generateBoardBlueprint(app: any, sources: RequirementSource[], flavour?: BoardFlavour): string {
    const { members, irqs } = boardMembers(app, sources);
    const { ns, name } = boardTypeParts(app);
    const features = app.features || {};
    let out = `// ==========================================================================\n`;
    out += `// BOARD ${name} for the ${app.name} application\n`;
    out += `// Created by FreeActors from what the application requires; this file is yours to complete.\n`;
    out += `// Every member is a stub that compiles: replace each TODO with the vendor-specific code.\n`;
    out += `// When the application needs more later, Export Application appends the missing members, marked\n`;
    out += `// "TODO (added by export)"; it never changes what is here.\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n\n#include <cstddef>\n#include <cstdint>\n`;
    if (features.health) out += `#include "fa_health.hpp"   // Fa::ResetCause\n`;
    out += `// TODO: the vendor's device header (CMSIS), e.g. #include "stm32f4xx.h"\n\n`;
    if (irqs.length > 0) out += `extern "C" uint32_t _estack;   // top of the main stack, from the linker script (CMSIS scripts: __StackTop)\n\n`;
    if (ns) out += `namespace ${ns} {\n\n`;
    out += `struct ${name} {\n`;
    const sections = ['START-UP', ...(irqs.length > 0 ? ['INTERRUPTS'] : []), 'DRIVERS', 'TRACE (FA_TRACE)',
                      'COMMANDS (FA_TRACE_COMMANDS)', 'WATCHDOG (FA_HEALTH)', 'RESET (FA_DEBUG_COMMANDS)'];
    for (const section of sections) {
        const inSection = members.filter(m => m.section === section);
        if (section !== 'INTERRUPTS' && inSection.length === 0) continue;
        out += `    // ======================================================================\n`;
        out += `    // ${section}\n    // ${SECTION_GUIDANCE[section]!.split('\n').join('\n    ')}\n`;
        out += `    // ======================================================================\n`;
        if (section === 'INTERRUPTS') {
            out += `    struct Irq {\n${irqs.map((i, n) => irqLine(i, n)).join('')}    };\n`;
            out += `    static constexpr size_t irq_count = 240;                      // TODO: the device's number of interrupts (sizes the vector table)\n`;
            out += `    static constexpr void const* initial_stack = &_estack;        // entry 0 of the vector table (FreeRTOS reads it)\n\n`;
        } else {
            out += inSection.map(memberLines).join('') + `\n`;
        }
    }
    out += `};\n`;
    if (ns) out += `\n} // namespace ${ns}\n`;
    if (flavour) {   // a vendor flavour: its header, its start-up call, the device's interrupt count
        out = out.replace(`// TODO: the vendor's device header (CMSIS), e.g. #include "stm32f4xx.h"`, flavour.include)
                 .replace('static void init() { /* TODO: vendor start-up (HAL/SDK init), clock tree, then each peripheral below */ }',
                          `static void init() {\n        ${flavour.init}\n        // TODO: the clock tree, then each peripheral below\n    }`);
        if (flavour.irqCount) {
            out = out.replace(/static constexpr size_t irq_count = 240;\s*\/\/ TODO: the device's number of interrupts \(sizes the vector table\)/,
                              `static constexpr size_t irq_count = ${flavour.irqCount};                       // the device's number of interrupts (from its header)`);
        }
    }
    return out;
}

// A later export: appends to an existing board file what the application now requires and it lacks
export function appendMissingBoardMembers(content: string, app: any, sources: RequirementSource[]): { updated: string; added: string[] } {
    const { members, irqs } = boardMembers(app, sources);
    const { name } = boardTypeParts(app);
    const added: string[] = [];
    let updated = content;
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Missing interrupts go into the existing struct Irq (or a new one)
    const missingIrqs = irqs.filter(i => !new RegExp(`\\b${i.name}\\b`).test(code((/struct\s+Irq\s*\{[^}]*\}/.exec(code(updated)) || [''])[0])));
    const missingMembers = members.filter(m => !new RegExp(`\\b${m.key}\\s*\\(`).test(code(updated)));
    if (missingIrqs.length === 0 && missingMembers.length === 0) return { updated, added };

    const structStart = new RegExp(`struct\\s+${name}\\s*\\{`).exec(updated);
    if (!structStart) return { updated, added };
    // the struct's closing brace: brace matching from its opening
    let depth = 0, end = -1;
    for (let i = structStart.index + structStart[0].length - 1; i < updated.length; i++) {
        if (updated[i] === '{') depth++;
        else if (updated[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return { updated, added };

    let insert = '';
    if (missingIrqs.length > 0) {
        const irqBlock = /struct\s+Irq\s*\{/.exec(updated);
        if (irqBlock && irqBlock.index < end) {
            const close = updated.indexOf('}', irqBlock.index);
            const lineStart = updated.lastIndexOf('\n', close) + 1;     // before the closing line's indentation
            const lines = missingIrqs.map((i, n) => irqLine(i, 200 + n).replace('// TODO:', '// TODO (added by export):')).join('');
            updated = updated.slice(0, lineStart) + lines + updated.slice(lineStart);
        } else {
            insert += `    struct Irq {   // TODO (added by export): the interrupts the application's modules handle\n${missingIrqs.map((i, n) => irqLine(i, 200 + n)).join('')}    };\n`;
            if (!/\birq_count\b/.test(code(updated))) insert += `    static constexpr size_t irq_count = 240;   // TODO (added by export): the device's number of interrupts\n`;
            if (!/\binitial_stack\b/.test(code(updated))) insert += `    static constexpr void const* initial_stack = nullptr;   // TODO (added by export): &_estack (the linker script's top of stack)\n`;
        }
        added.push(...missingIrqs.map(i => `Irq::${i.name}`));
    }
    for (const m of missingMembers) {
        const lines = memberLines(m).replace(`    ${m.code}`, markAdded(m.code));
        added.push(m.key);
        // At the end of its section while the board still has the blueprint's banner; else in one block at the end
        const banner = updated.indexOf(`    // ${m.section}\n`);
        const bannerEnd = banner < 0 ? -1 : updated.indexOf('// ====', banner + m.section.length + 8);
        if (bannerEnd < 0) { insert += lines; continue; }
        let at = updated.indexOf('\n    // ====', bannerEnd);   // the next section's banner
        if (at < 0) { insert += lines; continue; }
        while (at > 0 && updated[at - 1] === '\n' && updated[at - 2] === '\n') at--;   // before the blank line
        updated = updated.slice(0, at) + lines + updated.slice(at);
    }
    if (insert) {
        const reStart = new RegExp(`struct\\s+${name}\\s*\\{`).exec(updated)!;
        depth = 0; end = -1;
        for (let i = reStart.index + reStart[0].length - 1; i < updated.length; i++) {
            if (updated[i] === '{') depth++;
            else if (updated[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        updated = updated.slice(0, end) + `\n    // ---- Added by export: the application now requires these ----\n` + insert + updated.slice(end);
    }
    return { updated, added };
}

// All tool-owned files of an application. requirementOwners: namespaces whose <owner>_hw_requirements.hpp exists
export function generateAppFiles(app: any, models: AppModelInfo[], requirementOwners: string[]): { [file: string]: string } {
    return {
        [appFileName(app, 'config.hpp')]: generateAppConfigString(app),
        [appFileName(app, 'app.hpp')]: generateAppHeaderString(app, models),
        [appFileName(app, 'app.cpp')]: generateAppSourceString(app),
        [appFileName(app, 'main.cpp')]: generateAppMainString(app),
        [appFileName(app, 'app_hw_contract.hpp')]: generateAppHwContractString(String(app.name || 'App'), requirementOwners),
    };
}

// ==========================================================================
// APPLICATION CHECKS (docs/design/app-diagram.md, section 3): what the compiler cannot check, or only with
// unreadable template errors, reported on the diagram and in VS Code's Problems panel.
// ==========================================================================
export interface AppProblem {
    severity: 'error' | 'warning';
    message: string;
    component?: string;     // component id the problem belongs to
    connection?: string;    // connection id
}

const COMPOSITE_KINDS = ['application', 'subsystem'];
const SERVICE_KINDS = ['spsc', 'mpsc', 'dma'];

// What the provider found on disk for the Target's paths (targetPaths): exists, and the linker script's text
export interface TargetFiles { [path: string]: { exists: boolean; content?: string } }

export function checkAppModel(app: any, models: AppModelInfo[], files?: TargetFiles): AppProblem[] {
    const problems: AppProblem[] = [];
    const components: any[] = Array.isArray(app.components) ? app.components : [];
    const connections: any[] = Array.isArray(app.connections) ? app.connections : [];
    const byId = new Map<string, any>(components.map(c => [c.id, c]));
    const error = (message: string, where: { component?: string; connection?: string } = {}) =>
        problems.push({ severity: 'error', message, ...where });
    const warning = (message: string, where: { component?: string; connection?: string } = {}) =>
        problems.push({ severity: 'warning', message, ...where });
    const settings = app.settings || {};
    const features = app.features || {};

    // ---- The application ----
    if (!app.board || !app.board.type) {
        warning('No board type: set the board (AppTraits::Platform) in the Application section');
    }
    if (features.commands && !features.trace) error('Commands (FA_TRACE_COMMANDS) need Trace (FA_TRACE): replies travel on the trace');
    if (features.debug_commands && !features.commands) error('Debug commands (FA_DEBUG_COMMANDS) need Commands (FA_TRACE_COMMANDS)');
    if (features.health) {
        const check = Number(settings.HealthCheckMs ?? 100), watchdog = Number(settings.WatchdogTimeoutMs ?? 1000);
        if (watchdog < 3 * check) {
            error(`WatchdogTimeoutMs (${watchdog}) must be at least 3 x HealthCheckMs (${check}): one late check would reset the chip`);
        }
    }

    // ---- Components ----
    const names = new Map<string, string>();
    const modelUsers = new Map<string, string[]>();
    for (const c of components) {
        const where = { component: c.id };
        if (!/^[A-Za-z_]\w*$/.test(String(c.name || ''))) error(`"${c.name}" is not a C++ identifier`, where);
        // The application's own name is not a module of the code: it may equal its main actor's (Timebomb)
        if (c.kind !== 'application') {
            if (names.has(c.name)) error(`Two components are named ${c.name}`, where);
            names.set(c.name, c.id);
        }
        if (c.parent !== undefined && !byId.has(c.parent)) error(`${c.name} is inside a component that does not exist`, where);
        if (c.parent !== undefined && byId.has(c.parent) && !COMPOSITE_KINDS.includes(byId.get(c.parent).kind)) {
            error(`${c.name} is inside ${byId.get(c.parent).name}, which is not an application or a subsystem`, where);
        }
        if (c.kind === 'actor') {
            if (!c.model) {
                // Top-down: the machine is created by Export Application (or Create State Machine) as <Name>.hsm.json
                const planned = plannedModelFile(c.name);
                warning(`Actor ${c.name} has no state machine yet: Export Application creates ${planned} with the events sent to it`, where);
                if (models.some(m => m.file === planned)) modelUsers.set(planned, [...(modelUsers.get(planned) || []), c.name]);
            } else if (!models.some(m => m.file === c.model)) {
                error(`Actor ${c.name}: state machine ${c.model} not found next to the application, or not a valid model`, where);
            } else {
                modelUsers.set(c.model, [...(modelUsers.get(c.model) || []), c.name]);
            }
        }
        if (c.kind === 'periodic' && !(Number(c.period_ms) > 0)) error(`${c.name}: the period must be at least 1 ms`, where);
        if (c.kind === 'interrupt') {
            if (c.commands && !features.commands) {
                error(`Interrupt ${c.name} feeds the PC commands, but Commands (FA_TRACE_COMMANDS) is off`, where);
            }
            if (!c.irq) warning(`Interrupt ${c.name}: no interrupt chosen (the board's Irq:: name)`, where);
            const maxSyscall = Number(settings.MaxSyscallPriority ?? 5);
            if (Number(c.pri) < maxSyscall) {
                error(`Interrupt ${c.name}: priority ${c.pri} is more urgent than FreeRTOS allows for its calls ` +
                      `(configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY ${maxSyscall}): use ${maxSyscall} or higher`, where);
            }
        }
        if ((c.kind === 'spsc' || c.kind === 'mpsc') && !c.item) error(`${c.name}: no item type`, where);
        if (SERVICE_KINDS.includes(c.kind) && !(Number(c.size) > 0)) error(`${c.name}: the buffer size must be at least 1`, where);
        if (Number(c.stack) > 0 && Number(c.stack) < 64) warning(`${c.name}: a stack of ${c.stack} words is very small`, where);
    }
    for (const [model, users] of modelUsers) {
        if (users.length > 1) {
            for (const name of users) {
                error(`${model} is used by ${users.join(' and ')}: one instance per state machine (multiple instances come in v2)`,
                      { component: names.get(name)! });
            }
        }
    }
    const interrupts = components.filter(c => c.kind === 'interrupt' && c.irq);
    for (const c of interrupts) {
        const same = interrupts.filter(o => o.irq === c.irq);
        if (same.length > 1) error(`Interrupt Irq::${c.irq} is used by ${same.map(o => o.name).join(' and ')}`, { component: c.id });
    }
    for (const kind of ['spsc', 'mpsc']) {
        const services = components.filter(c => c.kind === kind && c.item);
        for (const c of services) {
            const same = services.filter(o => o.item === c.item);
            if (same.length > 1) {
                error(`Items of type ${c.item} go to ${same.map(o => o.name).join(' and ')}: pushes are routed by item type, ` +
                      'so one service per type', { component: c.id });
            }
        }
    }

    // ---- Connections ----
    for (const conn of connections) {
        const where = { connection: conn.id };
        const from = byId.get(conn.from), to = byId.get(conn.to);
        if (!from || !to) { error('A connection to a component that does not exist', where); continue; }
        if (COMPOSITE_KINDS.includes(from.kind) || COMPOSITE_KINDS.includes(to.kind)) {
            error(`${from.name} → ${to.name}: connect components, not applications or subsystems`, where);
            continue;
        }
        if (conn.kind === 'event') {
            if (to.kind !== 'actor') { error(`${from.name} → ${to.name}: events go to actors; a ${to.kind} takes items or streams`, where); continue; }
            const model = models.find(m => m.file === to.model);
            const events: string[] = Array.isArray(conn.events) ? conn.events : [];
            if (events.length === 0) error(`${from.name} → ${to.name}: no events chosen`, where);
            for (const e of events) {
                if (!IDENTIFIER.test(e)) error(`${from.name} → ${to.name}: "${e}" is not a C++ identifier (an event is a struct)`, where);
                else if (model && !model.signals.includes(e)) {
                    warning(`${from.name} → ${to.name}: ${to.name}'s state machine (${model.file}) has no signal ${e} yet: ` +
                            'Export Application adds it', where);
                }
            }
        } else if (conn.kind === 'item') {
            if (to.kind !== 'spsc' && to.kind !== 'mpsc') { error(`${from.name} → ${to.name}: items go to SPSC or MPSC services`, where); continue; }
            if (conn.item && to.item && conn.item !== to.item) {
                error(`${from.name} → ${to.name}: pushes ${conn.item}, but ${to.name} takes ${to.item}`, where);
            }
        } else if (conn.kind === 'stream') {
            if (to.kind !== 'dma') { error(`${from.name} → ${to.name}: a DMA stream goes to a DMA ring service`, where); continue; }
            if (from.kind !== 'interrupt') warning(`${from.name} → ${to.name}: DMA progress is normally reported by an interrupt module`, where);
        }
    }
    // One producer per SPSC service, and of one kind: the type cannot enforce it, and two corrupt it silently
    for (const c of components.filter(x => x.kind === 'spsc')) {
        const producers = connections.filter(x => x.to === c.id && x.kind === 'item').map(x => byId.get(x.from)).filter(Boolean);
        if (producers.length > 1) {
            error(`SPSC service ${c.name} has ${producers.length} producers (${producers.map((p: any) => p.name).join(', ')}): ` +
                  'it allows exactly one; use an MPSC service', { component: c.id });
        }
    }
    // ---- The target (the board's build decisions) ----
    const t = targetOf(app);
    const targetUsed = Object.keys(t).some(k => k !== 'core' && (t as any)[k] !== undefined && (t as any)[k] !== '' &&
                                                 !(Array.isArray((t as any)[k]) && (t as any)[k].length === 0));
    if (t.core && !TARGET_CORES[t.core]) {
        error(`Target: core ${t.core} is not supported (FreeActors needs an ARMv7-M or ARMv8-M Mainline core: ${Object.values(TARGET_CORES).map(x => x.label).join(', ')})`);
    } else if (!t.core && targetUsed) {
        warning('Target: choose the core, or Export Application writes no firmware build');
    }
    if (t.core && !(t.linker_script || '').trim()) warning('Target: no linker script (the firmware cannot link)');
    if (files) {
        for (const p of targetPaths(app)) {
            if (files[p] && !files[p]!.exists) warning(`Target: ${p} not found`);
        }
        const ld = (t.linker_script || '').trim();
        const script = ld ? files[ld] : undefined;
        if (features.health && script && script.exists && script.content !== undefined && !/\.noinit\b/.test(script.content)) {
            error(`Target: the linker script ${ld} has no .noinit section: the health monitor keeps its fault record there ` +
                  'across resets (add: .noinit (NOLOAD) : { *(.noinit*) } > RAM)');
        }
    }

    // Actors nothing posts to (they may still run on their own timers)
    for (const c of components.filter(x => x.kind === 'actor')) {
        if (!connections.some(x => x.to === c.id)) {
            warning(`Actor ${c.name} receives no events from any component (fine if it runs on its own timers)`, { component: c.id });
        }
    }
    return problems;
}

class FreeActorsAppEditorProvider implements vscode.CustomTextEditorProvider {

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const diagnostics = vscode.languages.createDiagnosticCollection('freeactors-app');
        context.subscriptions.push(diagnostics);
        return vscode.window.registerCustomEditorProvider(FreeActorsAppEditorProvider.viewType,
                                                          new FreeActorsAppEditorProvider(context, diagnostics));
    }

    private static readonly viewType = 'freeactors.appEditor';

    constructor(private readonly context: vscode.ExtensionContext,
                private readonly diagnostics: vscode.DiagnosticCollection) { }

    // The problems as VS Code diagnostics, each on the line of the component or connection it is about
    private publishDiagnostics(document: vscode.TextDocument, problems: AppProblem[]) {
        const text = document.getText();
        const lineOf = (id: string | undefined) => {
            if (!id) return 0;
            const at = text.indexOf(`"id": "${id}"`);
            return at < 0 ? 0 : document.positionAt(at).line;
        };
        this.diagnostics.set(document.uri, problems.map(p => {
            const line = lineOf(p.component ?? p.connection);
            const d = new vscode.Diagnostic(document.lineAt(line).range, p.message,
                p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            d.source = 'FreeActors';
            return d;
        }));
    }

    // Writes the tool-owned application files (generateAppFiles) next to the model; refused while it has errors
    // The Target's files as the checks need them: whether each exists, and the linker script's text
    private async targetFiles(app: any, folderUri: vscode.Uri): Promise<TargetFiles> {
        const files: TargetFiles = {};
        const linker = (targetOf(app).linker_script || '').trim();
        for (const p of targetPaths(app)) {
            const uri = /^(\/|[A-Za-z]:[\\/])/.test(p) ? vscode.Uri.file(p) : vscode.Uri.joinPath(folderUri, p);
            const content = p === linker ? await readFileIfExists(uri) : undefined;
            const exists = content !== undefined || await fileExists(uri);
            files[p] = content !== undefined ? { exists, content } : { exists };
        }
        return files;
    }

    // The state machines next to the application, read from open documents when open (unsaved edits count)
    private async modelsIn(folderUri: vscode.Uri): Promise<AppModelInfo[]> {
        const found: AppModelInfo[] = [];
        for (const [name, type] of await vscode.workspace.fs.readDirectory(folderUri)) {
            if (type !== vscode.FileType.File || !name.endsWith('.hsm.json')) continue;
            const info = describeHsmModel(name, (await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folderUri, name))).getText());
            if (info) found.push(info);
        }
        return found.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Top-down: the state machine of an actor drawn without one, <Name>.hsm.json with the signals the application
    // sends it (an existing file of that name is linked and given the missing signals), linked in the application.
    // Returns the file name, or undefined if the actor already has a state machine.
    private async createStateMachine(document: vscode.TextDocument, folderUri: vscode.Uri, id: string): Promise<string | undefined> {
        const app = JSON.parse(document.getText());
        const actor = ((app.components || []) as any[]).find(c => c.id === id && c.kind === 'actor');
        if (!actor) throw new Error('Create State Machine: not an actor');
        if (actor.model) return undefined;
        const file = plannedModelFile(actor.name);
        const users = ((app.components || []) as any[]).filter(c => c.kind === 'actor' && c.model === file);
        if (users.length > 0) throw new Error(`${file} is already the state machine of ${users[0].name}: one instance per state machine`);
        const uri = vscode.Uri.joinPath(folderUri, file);
        const sent = [...new Set(((app.connections || []) as any[])
            .filter(x => x.kind === 'event' && x.to === id && Array.isArray(x.events)).flatMap(x => x.events as string[]))]
            .filter(s => IDENTIFIER.test(s));
        if (!(await fileExists(uri))) {
            await vscode.workspace.fs.writeFile(uri, stringToUint8Array(JSON.stringify(defaultHsmModel(actor.name, sent), null, 2)));
        }
        await editJsonDocument(document.uri, a => {
            const c = ((a.components || []) as any[]).find(x => x.id === id);
            if (!c || c.model) return false;
            c.model = file;
            return true;
        });
        await addSentSignalsToModels(folderUri, JSON.parse(document.getText()), await this.modelsIn(folderUri));
        return file;
    }

    private async exportApplication(document: vscode.TextDocument, folderUri: vscode.Uri, models: AppModelInfo[]) {
        let app: any;
        try {
            app = JSON.parse(document.getText());
        } catch (e: any) {
            vscode.window.showErrorMessage(`❌ Export failed: the application model is not valid JSON (${e.message})`);
            return;
        }
        const errors = checkAppModel(app, models, await this.targetFiles(app, folderUri)).filter(p => p.severity === 'error');
        if (errors.length > 0) {
            vscode.window.showErrorMessage(`❌ Export refused: ${errors.length} error(s) in the application, e.g. "${errors[0]!.message}". ` +
                                           'See the Problems list in the editor.');
            return;
        }
        // State machines: created for actors drawn without one (top-down), given the signals the application sends,
        // and exported, so the whole project is up to date after one click
        const created: string[] = [];
        for (const c of ((app.components || []) as any[]).filter(c => c.kind === 'actor' && !c.model)) {
            const file = await this.createStateMachine(document, folderUri, c.id);
            if (file) created.push(file);
        }
        try { app = JSON.parse(document.getText()); } catch { /* unchanged */ }
        await addSentSignalsToModels(folderUri, app, models);
        models = await this.modelsIn(folderUri);
        const exported: string[] = [];
        for (const c of ((app.components || []) as any[]).filter(c => c.kind === 'actor' && c.model)) {
            const uri = vscode.Uri.joinPath(folderUri, c.model);
            try {
                const result = await exportStateMachine(this.context, folderUri, (await vscode.workspace.openTextDocument(uri)).getText());
                exported.push(result.name);
            } catch (e: any) {
                vscode.window.showErrorMessage(`❌ Export of ${c.model} failed: ${e.message}`);
                return;
            }
        }
        await copyFrameworkFilesToWorkspace(this.context, folderUri);   // also without actors: modules need it
        // Modules: requirements and module file created once (yours); contract and TestBsp regenerated
        for (const c of (app.components || []) as any[]) {
            if (!['periodic', 'interrupt', 'spsc', 'mpsc', 'dma'].includes(c.kind)) continue;
            const lower = String(c.name).toLowerCase();
            const reqUri = vscode.Uri.joinPath(folderUri, hwRequirementsFile(lower));
            let requirements = await readFileIfExists(reqUri);
            if (requirements === undefined) {
                requirements = generateModuleRequirementsStub(app, c, models);
                await vscode.workspace.fs.writeFile(reqUri, stringToUint8Array(requirements));
                created.push(hwRequirementsFile(lower));
            }
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folderUri, `${lower}_hw_contract.hpp`),
                                                stringToUint8Array(generateCpHwContractString(c.name, requirements)));
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folderUri, `${lower}_test_bsp.hpp`),
                                                stringToUint8Array(generateCppTestBspString(c.name, requirements)));
            const moduleUri = vscode.Uri.joinPath(folderUri, moduleFileName(c.name));
            if (!(await fileExists(moduleUri))) {
                await vscode.workspace.fs.writeFile(moduleUri, stringToUint8Array(generateModuleSkeleton(app, c, models)));
                created.push(moduleFileName(c.name));
            }
        }
        const { sources, missingActors } = await this.requirementSources(app, folderUri, models);
        const files = generateAppFiles(app, models, sources.map(s => s.owner));
        for (const [file, content] of Object.entries(files)) {
            await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folderUri, file), stringToUint8Array(content));
        }
        // The firmware build, when the board's Target names a core (section 7.5)
        let firmwareNote = '';
        if (targetOf(app).core) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folderUri, 'cmake'));
            for (const [file, content] of Object.entries(generateFirmwareFiles(app))) {
                const uri = vscode.Uri.joinPath(folderUri, file);
                if (file === 'CMakePresets.json') {
                    const existing = await readFileIfExists(uri);
                    let ours = existing === undefined;
                    try { ours = ours || Boolean(JSON.parse(existing!).vendor?.freeactors); } catch { /* not JSON: yours */ }
                    if (!ours) { firmwareNote += ' CMakePresets.json is yours, so it was left as is: it needs a "firmware" preset with the toolchain file cmake/arm-none-eabi.cmake.'; continue; }
                }
                await vscode.workspace.fs.writeFile(uri, stringToUint8Array(content));
            }
            const userConfig = vscode.Uri.joinPath(folderUri, FREERTOS_USER_CONFIG_FILENAME);
            if (!(await fileExists(userConfig))) {
                await vscode.workspace.fs.writeFile(userConfig, stringToUint8Array(generateFreeRTOSUserConfigStub(app)));
                created.push(FREERTOS_USER_CONFIG_FILENAME);
            }
            const cmakeUri = vscode.Uri.joinPath(folderUri, 'CMakeLists.txt');
            const cmake = await readFileIfExists(cmakeUri);
            if (cmake === undefined) {
                await vscode.workspace.fs.writeFile(cmakeUri, stringToUint8Array(generateCMakeListsString(JSON.stringify({ name: app.name }))));
            } else if (!cmake.includes(FIRMWARE_CMAKE_FILENAME)) {
                firmwareNote += ` To build the firmware, add after project(...) in CMakeLists.txt: ` +
                    `if(CMAKE_CROSSCOMPILING) include(\${CMAKE_CURRENT_SOURCE_DIR}/${FIRMWARE_CMAKE_FILENAME}) return() endif()`;
            }
            firmwareNote = ` Firmware build: cmake --preset firmware && cmake --build --preset firmware${(targetOf(app).flash || '').trim() ? ' --target flash' : ''}.` + firmwareNote;
        }

        // The board, when it lives next to the application: what the requirements gained since is appended
        let boardNote = '';
        const boardUri = this.boardUri(app, folderUri);
        const board = boardUri && await readFileIfExists(boardUri);
        if (boardUri && board !== undefined) {
            const { updated, added } = appendMissingBoardMembers(board, app, sources);
            if (added.length > 0) {
                await vscode.workspace.fs.writeFile(boardUri, stringToUint8Array(updated));
                boardNote = ` Added to the board ${app.board.header}, for you to implement: ${added.join(', ')}.`;
            }
        } else if (boardUri) {
            boardNote = ` The board ${app.board.header} does not exist yet: Generate Board creates it.`;
        }
        vscode.window.showInformationMessage(`🚀 Application exported: ${Object.keys(files).join(', ')}` +
            (exported.length > 0 ? `, and the state machines ${exported.join(', ')}.` : '.') +
            (created.length > 0 ? ` Created for you to fill in: ${created.join(', ')}.` : '') + boardNote + firmwareNote +
            (missingActors.length > 0 ? ` Export these state machines too (their actor files are missing): ${missingActors.join(', ')}.` : ''));
    }

    // Every component whose requirements file exists takes part in the application-wide hardware contract and the board
    private async requirementSources(app: any, folderUri: vscode.Uri, models: AppModelInfo[]) {
        const sources: RequirementSource[] = [];
        const missingActors: string[] = [];
        for (const c of (app.components || []) as any[]) {
            if (c.kind === 'application' || c.kind === 'subsystem') continue;
            const owner = c.kind === 'actor' ? (models.find(m => m.file === c.model) || { name: c.name }).name : c.name;
            const content = await readFileIfExists(vscode.Uri.joinPath(folderUri, hwRequirementsFile(owner.toLowerCase())));
            if (content !== undefined) {
                sources.push({ owner, content });
            } else if (c.kind === 'actor') {
                missingActors.push(c.model);
            }
        }
        return { sources, missingActors };
    }

    // The board header, relative to the application file; undefined when the board type or header is not set
    private boardUri(app: any, folderUri: vscode.Uri): vscode.Uri | undefined {
        const header = String(app?.board?.header || '').trim();
        if (!header || !String(app?.board?.type || '').trim()) return undefined;
        return vscode.Uri.joinPath(folderUri, header);
    }

    // The vendor flavour's additions to the board blueprint (its device header read from the SDK, if there)
    private async boardFlavour(app: any, folderUri: vscode.Uri): Promise<BoardFlavour | undefined> {
        const t = targetOf(app);
        if (t.flavour !== 'stm32f4-hal') return undefined;
        const header = vscode.Uri.joinPath(folderUri, (t.sdk || 'third_party/st').trim(), 'cmsis_device_f4', 'Include', `${(t.part || 'STM32F446xx').trim().toLowerCase()}.h`);
        return boardFlavourOf(app, await readFileIfExists(header));
    }

    // Apply flavour: the Target's fields from the vendor's SDK layout, and the vendor-side files created if missing
    private async applyFlavour(document: vscode.TextDocument, folderUri: vscode.Uri) {
        const app = JSON.parse(document.getText());
        const t = targetOf(app);
        if (t.flavour !== 'stm32f4-hal') {
            vscode.window.showErrorMessage('❌ Choose a vendor flavour first (Target section).');
            return;
        }
        const flavour = stm32f4HalFlavour(app);
        await editJsonDocument(document.uri, a => { a.board = a.board || {}; a.board.target = flavour.target; return true; });
        const created: string[] = [], notes: string[] = [];
        for (const [file, content] of Object.entries(flavour.create)) {
            const uri = vscode.Uri.joinPath(folderUri, file);
            if (await fileExists(uri)) continue;
            await vscode.workspace.fs.writeFile(uri, stringToUint8Array(content));
            created.push(file);
        }
        for (const [file, from] of Object.entries(flavour.copy)) {
            const uri = vscode.Uri.joinPath(folderUri, file);
            if (await fileExists(uri)) continue;
            const template = await readFileIfExists(vscode.Uri.joinPath(folderUri, from));
            if (template === undefined) { notes.push(`${file} not created: ${from} not found (the SDK below)`); continue; }
            await vscode.workspace.fs.writeFile(uri, stringToUint8Array(template));
            created.push(`${file} (from ST's template)`);
        }
        const sdk = flavour.target.sdk!;
        const missing: string[] = [];
        for (const repo of STM32F4_SDK_REPOSITORIES) {
            if (!(await fileExists(vscode.Uri.joinPath(folderUri, sdk, repo)))) missing.push(repo);
        }
        if (missing.length > 0) {
            notes.push(`Get ST's SDK into ${sdk}: ` + missing.map(r => `git clone --depth 1 https://github.com/STMicroelectronics/${r} ${sdk}/${r}`).join('; ') +
                       ' (then Apply flavour again for the HAL configuration)');
        }
        vscode.window.showInformationMessage(`🧩 ${FLAVOURS[t.flavour]} for ${flavour.target.part}: the Target is filled in.` +
            (created.length > 0 ? ` Created for you: ${created.join(', ')}.` : '') + (notes.length > 0 ? ` ${notes.join('. ')}.` : ''));
    }

    // Generate Board: a compiling board skeleton from all the requirements; if the board exists, only what is missing
    private async generateBoard(document: vscode.TextDocument, folderUri: vscode.Uri, models: AppModelInfo[]) {
        let app: any;
        try {
            app = JSON.parse(document.getText());
        } catch (e: any) {
            vscode.window.showErrorMessage(`❌ The application model is not valid JSON (${e.message})`);
            return;
        }
        const boardUri = this.boardUri(app, folderUri);
        if (!boardUri) {
            vscode.window.showErrorMessage('❌ Set the board type (e.g. Board::MyBoard) and header (e.g. bsp_my_board.hpp) first.');
            return;
        }
        const { sources, missingActors } = await this.requirementSources(app, folderUri, models);
        const existing = await readFileIfExists(boardUri);
        let message: string;
        if (existing === undefined) {
            await vscode.workspace.fs.writeFile(boardUri, stringToUint8Array(generateBoardBlueprint(app, sources, await this.boardFlavour(app, folderUri))));
            message = `🛠️ Board ${app.board.header} created from the requirements of ${sources.map(s => s.owner).join(', ') || 'no module yet'}: fill in the TODOs.`;
        } else {
            const { updated, added } = appendMissingBoardMembers(existing, app, sources);
            if (added.length > 0) await vscode.workspace.fs.writeFile(boardUri, stringToUint8Array(updated));
            message = added.length > 0 ? `🛠️ Added to the board ${app.board.header}: ${added.join(', ')}.`
                                       : `✅ The board ${app.board.header} already has everything the application requires.`;
        }
        if (missingActors.length > 0) message += ` Not included (export these state machines first): ${missingActors.join(', ')}.`;
        vscode.window.showInformationMessage(message);
        await vscode.window.showTextDocument(boardUri);
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };
        const folderUri = vscode.Uri.joinPath(document.uri, '..');

        if (document.getText().trim().length === 0) {
            const base = (document.uri.fsPath.split(/[\\/]/).pop() || 'App').split('.')[0] || 'App';
            const clean = base.replace(/[^a-zA-Z0-9_]/g, '') || 'App';
            const name = clean.charAt(0).toUpperCase() + clean.slice(1);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), JSON.stringify(defaultAppModel(name), null, 2));
            await vscode.workspace.applyEdit(edit);
        }

        const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const html = uint8ArrayToString(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaUri, 'app.html')));
        const asUri = (file: string) => webviewPanel.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file)).toString();
        webviewPanel.webview.html = html
            .replace('{{styleUri}}', asUri('style.css'))
            .replace('{{appStyleUri}}', asUri('app.css'))
            .replace('{{canvasUri}}', asUri('canvas.js'))
            .replace('{{scriptUri}}', asUri('app.js'));

        // The state machines next to the application file: what actors can use, and the events they accept
        const scanModels = async (): Promise<AppModelInfo[]> => {
            const found: AppModelInfo[] = [];
            for (const [name, type] of await vscode.workspace.fs.readDirectory(folderUri)) {
                if (type !== vscode.FileType.File || !name.endsWith('.hsm.json')) continue;
                const uri = vscode.Uri.joinPath(folderUri, name);
                const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
                const text = open ? open.getText() : uint8ArrayToString(await vscode.workspace.fs.readFile(uri));   // unsaved edits count
                const info = describeHsmModel(name, text);
                if (info) found.push(info);
            }
            return found.sort((a, b) => a.name.localeCompare(b.name));
        };

        const update = async () => {
            const models = await scanModels();
            let problems: AppProblem[] = [];
            try {
                const app = JSON.parse(document.getText());
                problems = checkAppModel(app, models, await this.targetFiles(app, folderUri));
            } catch (e: any) {
                problems = [{ severity: 'error', message: `Not a valid application model (JSON): ${e.message}` }];
            }
            this.publishDiagnostics(document, problems);
            webviewPanel.webview.postMessage({ type: 'update', text: document.getText(), models, problems });
        };

        const subscriptions = [
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === document.uri.toString()) update();
            }),
            // a state machine next to the application changed (edited, or saved): its signals may have changed
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.fsPath.endsWith('.hsm.json')) update();
            }),
            vscode.workspace.onDidSaveTextDocument(d => {
                if (d.uri.fsPath.endsWith('.hsm.json')) update();
            }),
        ];
        webviewPanel.onDidDispose(() => {
            subscriptions.forEach(s => s.dispose());
            this.diagnostics.delete(document.uri);
        });

        webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'ready':
                    await update();
                    return;
                case 'documentEdit': {
                    if (message.jsonText === document.getText()) return;
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), message.jsonText);
                    await vscode.workspace.applyEdit(edit);
                    // events typed on a connection become signals of the receiving machine (one source of truth)
                    try {
                        const note = await addSentSignalsToModels(folderUri, JSON.parse(message.jsonText), await scanModels());
                        if (note) vscode.window.showInformationMessage(note);
                    } catch { /* not valid JSON: the checks report it */ }
                    return;
                }
                case 'createStateMachine': {
                    try {
                        const file = await this.createStateMachine(document, folderUri, String(message.id));
                        if (file) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folderUri, file), 'freeactors.hsmEditor');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`❌ ${e.message}`);
                    }
                    return;
                }
                case 'renameSignal': {
                    try {
                        vscode.window.showInformationMessage(await renameSignalEverywhere(folderUri, String(message.model), String(message.from), String(message.to)));
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`❌ Rename refused: ${e.message}`);
                    }
                    return;
                }
                case 'exportApplication': {
                    await this.exportApplication(document, folderUri, await scanModels());
                    return;
                }
                case 'applyFlavour': {
                    try { await this.applyFlavour(document, folderUri); } catch (e: any) { vscode.window.showErrorMessage(`❌ ${e.message}`); }
                    return;
                }
                case 'generateBoard': {
                    await this.generateBoard(document, folderUri, await scanModels());
                    return;
                }
                case 'openFile': {
                    const uri = vscode.Uri.joinPath(folderUri, String(message.file));
                    if (String(message.file).endsWith('.hsm.json')) {
                        await vscode.commands.executeCommand('vscode.openWith', uri, 'freeactors.hsmEditor');
                    } else if (await fileExists(uri)) {
                        await vscode.window.showTextDocument(uri);
                    } else {
                        vscode.window.showInformationMessage(`${message.file} does not exist yet: Export Application creates it.`);
                    }
                    return;
                }
            }
        });
    }
}

function normalizeActionName(actionName: string, machine: string): string {
    if (!actionName) return actionName;
    return actionName
        .replace(new RegExp(`entry_${machine}_ROOT`, 'gi'), 'entry_ROOT')
        .replace(new RegExp(`exit_${machine}_ROOT`, 'gi'), 'exit_ROOT');
}

function toPascalCase(str: string): string {
    const clean = str.replace(/[^a-zA-Z0-9_]/g, "");
    if (!clean) return "Unnamed";
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// Splits a transition/internal-event trigger of the form "Signal" or "Signal / action()".
// Every part of the generator must use this so that they agree on which signal a reaction belongs to.
function parseTrigger(event: unknown): { signal: string; action: string } {
    if (typeof event !== 'string') return { signal: "", action: "" };
    const clean = event.replace('·', '').trim();
    const slash = clean.indexOf('/');
    if (slash === -1) return { signal: clean, action: "" };
    return { signal: clean.slice(0, slash).trim(), action: clean.slice(slash + 1).trim() };
}

// Rejects models the generator cannot turn into correct C++. Called before any file is written.
export function validateHsmModel(jsonText: string): void {
    let hsm: any;
    try {
        hsm = JSON.parse(jsonText);
    } catch (e: any) {
        throw new Error(`Invalid HSM JSON: ${e.message}`);
    }

    // Two unguarded reactions to the same signal in one state is a conflict: both would be enabled at once.
    const problems: string[] = [];
    for (const s of (hsm.states || []) as any[]) {
        const unguardedCount = new Map<string, number>();
        const count = (signal: string) => unguardedCount.set(signal, (unguardedCount.get(signal) || 0) + 1);

        for (const t of (s.transitions || []) as any[]) {
            const { signal } = parseTrigger(t.event);
            if (signal && !t.guard) count(signal);
        }
        for (const ev of (s.local_events || []) as any[]) {
            const { signal } = parseTrigger(ev);
            if (signal) count(signal);
        }
        for (const [signal, n] of unguardedCount) {
            if (n > 1) {
                problems.push(`state '${s.name}': signal '${signal}' has ${n} unguarded reactions (transitions and internal events); all but one must be guarded`);
            }
        }
    }
    if (problems.length > 0) {
        throw new Error(`Model conflict — ${problems.join('; ')}`);
    }
}

// FNV-1a hash of the model's meaning (names, events, guards, actions, transitions) - not its layout, so
// moving states around in the editor does not change it. The target reports it in the trace HELLO frame.
export function modelHash(hsm: any): number {
    const states = ((hsm.states || []) as any[]).map((s: any) => ({
        id: s.id, name: s.name, parent: s.parent ?? null, entry: s.entry ?? "", exit: s.exit ?? "",
        transitions: ((s.transitions || []) as any[]).map((t: any) => ({ event: t.event ?? "", guard: t.guard ?? "", target: t.target ?? "" })),
        local_events: s.local_events || []
    }));
    const canonical = JSON.stringify({
        name: hsm.name, signals: hsm.signals || [], guards: hsm.guards || [], actions: hsm.actions || [], states
    });
    let hash = 0x811c9dc5;
    for (let i = 0; i < canonical.length; i++) {
        hash ^= canonical.charCodeAt(i) & 0xFF;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

interface MethodCatalogItem {
    rawMethod: string;
    pascalName: string;
    hasVoid: boolean;
    payloadEvents: Set<string>;
}

function extractCatalogs(hsm: any, machineName: string) {
    const rawStates = (hsm.states || []) as any[];
    const states = rawStates.map(s => ({
        ...s,
        name: (!s.parent || s.name === `${machineName}_ROOT` || s.name === "ROOT" || s.name === "STATE_ROOT") ? "ROOT" : s.name,
        entry: normalizeActionName(s.entry || "", machineName),
        exit: normalizeActionName(s.exit || "", machineName)
    }));

    const guardCatalog = new Map<string, MethodCatalogItem>();
    const actionCatalog = new Map<string, MethodCatalogItem>();

    const registerGuard = (rawName: string, payloadEvent?: string) => {
        const clean = rawName.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "").trim();
        if (!clean) return;
        const isParameterless = rawName.includes('()') || !payloadEvent;

        let item = guardCatalog.get(clean);
        if (!item) {
            item = { rawMethod: clean, pascalName: toPascalCase(clean), hasVoid: false, payloadEvents: new Set() };
            guardCatalog.set(clean, item);
        }
        if (isParameterless) item.hasVoid = true;
        if (payloadEvent && !rawName.includes('()')) item.payloadEvents.add(payloadEvent);
    };

    const registerAction = (rawName: string, payloadEvent?: string) => {
        const clean = rawName.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "").trim();
        if (!clean) return;
        const isParameterless = rawName.includes('()') || !payloadEvent;

        let item = actionCatalog.get(clean);
        if (!item) {
            item = { rawMethod: clean, pascalName: toPascalCase(clean), hasVoid: false, payloadEvents: new Set() };
            actionCatalog.set(clean, item);
        }
        if (isParameterless) item.hasVoid = true;
        if (payloadEvent && !rawName.includes('()')) item.payloadEvents.add(payloadEvent);
    };

    ((hsm.guards || []) as string[]).forEach(g => registerGuard(g));
    ((hsm.actions || []) as string[]).forEach(a => registerAction(a));

    states.forEach((s: any) => {
        if (s.entry) registerAction(s.entry);
        if (s.exit) registerAction(s.exit);

        if (s.transitions && Array.isArray(s.transitions)) {
            s.transitions.forEach((t: any) => {
                const { signal: signalToken, action: actionPart } = parseTrigger(t.event);
                const isInit = signalToken === 'Init_sig';
                const payloadEvent = isInit ? undefined : signalToken;

                if (t.guard) registerGuard(t.guard, payloadEvent);
                if (actionPart) registerAction(actionPart, payloadEvent);
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                const { signal: signalToken, action: actionPart } = parseTrigger(rawEv);
                if (actionPart) registerAction(actionPart, signalToken);
            });
        }
    });

    return { states, guardCatalog, actionCatalog };
}

// ==========================================================================
// UNIFIED STATE GRAPH & REACHABILITY METADATA GENERATOR
// ==========================================================================

interface UnifiedTransitionEdge {
    fromStateId: number;
    toStateName: string;
    signalName: string;
    isInit: boolean;
    guardTrits: number[]; // 0: False, 1: True, 2: Don't Care
}

function generateUnifiedReachabilityMetadata(
    states: any[], 
    guardEntries: { pascalName: string; rawMethod: string; id: number }[]
) {
    const totalGuards = guardEntries.length;
    const guardIndexMap = new Map<string, number>();
    guardEntries.forEach((g, idx) => guardIndexMap.set(g.pascalName, idx));

    const stateMap = new Map<string, any>();
    states.forEach(s => stateMap.set(s.id, s));

    const parentIdSet = new Set(states.map(s => s.parent).filter(Boolean));

    const isLeafList: boolean[] = [];
    const stateRanges: { start: number; count: number }[] = [];
    const allTransitions: UnifiedTransitionEdge[] = [];

    states.forEach((s, stateIdx) => {
        const isLeaf = !parentIdSet.has(s.id) && s.name !== "ROOT";
        isLeafList.push(isLeaf);

        const startIdx = allTransitions.length;

        if (!isLeaf) {
            // Composite states / ROOT only emit their direct local transitions (primarily Init_sig)
            const rawTransitions = (s.transitions || []) as any[];
            const bySignal = new Map<string, any[]>();
            rawTransitions.forEach(t => {
                const sigToken = parseTrigger(t.event).signal;
                if (!sigToken) return;
                const list = bySignal.get(sigToken) || [];
                list.push(t);
                bySignal.set(sigToken, list);
            });

            for (const [sigToken, transList] of bySignal.entries()) {
                let priorGuardsOnSignal: number[] = [];
                transList.forEach(t => {
                    const trits = new Array<number>(totalGuards).fill(2);
                    for (const gIdx of priorGuardsOnSignal) trits[gIdx] = 0;

                    if (t.guard) {
                        const cleanGuard = t.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                        const pascalGuard = toPascalCase(cleanGuard);
                        if (guardIndexMap.has(pascalGuard)) {
                            const gIdx = guardIndexMap.get(pascalGuard)!;
                            trits[gIdx] = 1;
                            priorGuardsOnSignal.push(gIdx);
                        }
                    }

                    const targetObj = stateMap.get(t.target);
                    const targetName = targetObj ? targetObj.name : "Fa::None";

                    allTransitions.push({
                        fromStateId: stateIdx,
                        toStateName: targetName,
                        signalName: sigToken,
                        isInit: sigToken === 'Init_sig',
                        guardTrits: trits
                    });
                });
            }
        } else {
            // Leaf states climb up to ROOT to inherit all unshadowed ancestor transitions
            const inheritedNegatedGuards = new Map<string, number[]>();
            const fullyShadowedSignals = new Set<string>();

            let curr: any = s;
            while (curr) {
                const rawTransitions = (curr.transitions || []) as any[];
                const bySignal = new Map<string, any[]>();
                rawTransitions.forEach(t => {
                    const sigToken = parseTrigger(t.event).signal;
                    if (!sigToken) return;
                    const list = bySignal.get(sigToken) || [];
                    list.push(t);
                    bySignal.set(sigToken, list);
                });

                for (const [sigToken, transList] of bySignal.entries()) {
                    // Rule: Never inherit Init_sig from ancestor composite states
                    if (sigToken === 'Init_sig' && curr !== s) {
                        continue;
                    }

                    if (fullyShadowedSignals.has(sigToken)) continue;

                    const priorNegated = inheritedNegatedGuards.get(sigToken) || [];

                    for (const t of transList) {
                        const trits = new Array<number>(totalGuards).fill(2);

                        // 1. Apply negative preconditions accumulated from child levels
                        for (const gIdx of priorNegated) {
                            trits[gIdx] = 0;
                        }

                        // 2. Apply positive guard on current transition (if any)
                        if (t.guard) {
                            const cleanGuard = t.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                            const pascalGuard = toPascalCase(cleanGuard);
                            if (guardIndexMap.has(pascalGuard)) {
                                const gIdx = guardIndexMap.get(pascalGuard)!;
                                trits[gIdx] = 1;
                            }
                        }

                        const targetObj = stateMap.get(t.target);
                        const targetName = targetObj ? targetObj.name : "Fa::None";

                        allTransitions.push({
                            fromStateId: stateIdx, // The edge is registered on this concrete leaf
                            toStateName: targetName,
                            signalName: sigToken,
                            isInit: sigToken === 'Init_sig',
                            guardTrits: trits
                        });
                    }

                    // Check for unconditional / catch-all handler at this level
                    const hasUnguarded = transList.some(t => !t.guard);
                    if (hasUnguarded) {
                        fullyShadowedSignals.add(sigToken);
                    } else {
                        const localGuards: number[] = [];
                        transList.forEach(t => {
                            if (t.guard) {
                                const cleanGuard = t.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                                const pascalGuard = toPascalCase(cleanGuard);
                                if (guardIndexMap.has(pascalGuard)) {
                                    localGuards.push(guardIndexMap.get(pascalGuard)!);
                                }
                            }
                        });
                        inheritedNegatedGuards.set(sigToken, [...priorNegated, ...localGuards]);
                    }
                }

                curr = curr.parent ? stateMap.get(curr.parent) : null;
            }
        }

        stateRanges.push({
            start: startIdx,
            count: allTransitions.length - startIdx
        });
    });

    return {
        isLeafList,
        stateRanges,
        allTransitions,
        totalGuards
    };
}

// ==========================================================================
// BSP POLICY INTERFACE & CONCEPT CONTRACT GENERATOR
// ==========================================================================

interface BspMethodSignature {
    rawLine: string;
    returnType: string;
    name: string;
    rawArgs: string;
    argTypes: string[];
}

function parseHwRequirementsHeader(fileContent: string): BspMethodSignature[] {
    const signatures: BspMethodSignature[] = [];

    // 1. Strip block comments (/* ... */) and single-line comments (// ...)
    const sanitizedContent = fileContent
        .replace(/\/\*[\s\S]*?\*\//g, '')       // Strip block comments
        .replace(/\/\/.*$/gm, '');               // Strip single-line comments

    // 2. Scan sanitized content for static method declarations
    const methodRegex = /static\s+([\w:<>]+(?:\s*\*|\s*&)?)\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*;/g;

    let match: RegExpExecArray | null;
    while ((match = methodRegex.exec(sanitizedContent)) !== null) {
        const returnType = (match[1] ?? "").trim();
        const name = (match[2] ?? "").trim();
        const rawArgs = (match[3] ?? "").trim();

        // Skip static constexpr values and member constants
        if (returnType.includes('constexpr') || returnType === 'const') continue;

        const argTypes: string[] = rawArgs.length === 0
            ? []
            : rawArgs.split(',').map(arg => {
                const parts = arg.trim().split(/\s+/).filter(Boolean);
                if (parts.length === 0) return "";
                return parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? "");
            }).filter((t: string) => t.length > 0);

        signatures.push({
            rawLine: (match[0] ?? "").trim(),
            returnType,
            name,
            rawArgs,
            argTypes
        });
    }
    return signatures;
}

// A machine's hardware requirements: what it needs from any board (declarations only). Before 0.0.9 the file
// was called <name>_bsp_policy.hpp; export renames an existing one once.
export const hwRequirementsFile = (lowerName: string) => `${lowerName}_hw_requirements.hpp`;
export const legacyHwRequirementsFile = (lowerName: string) => `${lowerName}_bsp_policy.hpp`;

// Interrupt numbers a module requires: the members of 'struct Irq { static const int name; ... };'
// (the board defines them as CMSIS IRQn_Type constants: struct Irq { static constexpr IRQn_Type name = ...; })
export function parseIrqRequirements(fileContent: string): string[] {
    const code = fileContent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const block = /struct\s+Irq\s*\{([^}]*)\}/.exec(code);
    if (!block) return [];
    const names: string[] = [];
    for (const m of (block[1] ?? '').matchAll(/static\s+[\w\s:]*?\b([A-Za-z_]\w*)\s*(?:=[^;]*)?;/g)) {
        if (m[1]) names.push(m[1]);
    }
    return names;
}

// What a module needs from the board: driver functions and interrupt numbers
export interface ModuleRequirements { owner: string; functions: { name: string; signature: string }[]; irqs: string[]; }

export function moduleRequirements(owner: string, content: string): ModuleRequirements {
    return {
        owner,
        functions: parseHwRequirementsHeader(content).map(m => ({
            name: m.name,
            signature: `static ${m.returnType} ${m.name}(${m.argTypes.join(', ')})`.replace(/\s+/g, ' '),
        })),
        irqs: parseIrqRequirements(content),
    };
}

// Requirements one board cannot satisfy at once: one function with two signatures, one interrupt for two modules
export function findRequirementConflicts(all: ModuleRequirements[]): string[] {
    const conflicts: string[] = [];
    const functions = new Map<string, { signature: string; owner: string }[]>();
    const irqs = new Map<string, string[]>();
    for (const m of all) {
        for (const f of m.functions) functions.set(f.name, [...(functions.get(f.name) || []), { signature: f.signature, owner: m.owner }]);
        for (const i of m.irqs) irqs.set(i, [...(irqs.get(i) || []), m.owner]);
    }
    for (const [name, uses] of functions) {
        const signatures = [...new Set(uses.map(u => u.signature))];
        if (signatures.length > 1) {
            conflicts.push(`Board function ${name} is required with different signatures: ` +
                           uses.map(u => `${u.owner}: ${u.signature}`).join('; '));
        }
    }
    for (const [name, owners] of irqs) {
        if (owners.length > 1) conflicts.push(`Interrupt Irq::${name} is required by ${owners.join(' and ')}: one interrupt per module`);
    }
    return conflicts;
}

export function generateCppHwRequirementsStub(machineName: string, kind: 'actor' | 'periodic' | 'interrupt' | 'service' = 'actor'): string {
    const lower = machineName.toLowerCase();
    let out = `// ==========================================================================\n`;
    const what = kind === 'actor' ? 'actor' : kind === 'periodic' ? 'periodic module' : kind === 'interrupt' ? 'interrupt module' : 'service';
    out += `// HARDWARE REQUIREMENTS - ${machineName} ${what}\n`;
    out += `// Created once by FreeActors; this file is yours to edit.\n`;
    out += `//\n`;
    out += `// Declare here the static driver functions the ${machineName} ${what} calls as Hw::name(...)` +
           (kind === 'interrupt' ? `,\n// and in struct Irq the interrupt it handles (used as Hw::Irq::name).\n` : `.\n`);
    out += `// This file only lists requirements - do not implement them here:\n`;
    out += `//   - your board file implements them (e.g. struct MyBoard { static void set_led(bool on) {...} };)\n`;
    out += `//     and the application selects the board once: AppTraits::Platform = MyBoard\n`;
    out += `//   - on export, FreeActors generates from these declarations\n`;
    out += `//       ${lower}_hw_contract.hpp  compile-time check that the board provides every function\n`;
    out += `//       ${lower}_test_bsp.hpp     TestBsp, the host test double used by the actor tests\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#include <cstdint>\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `struct HwRequirements {\n`;
    if (kind === 'interrupt') {
        out += `    // struct Irq { static const int button; };   // the board: struct Irq { static constexpr IRQn_Type button = EXTI15_10_IRQn; };\n`;
        out += `    // static bool button_ack();                  // acknowledge the interrupt (clear its flag); true = it was ours\n`;
    } else {
        out += `    // static void set_led(bool on);\n`;
        out += `    // static uint16_t read_adc(uint8_t channel);\n`;
    }
    out += `};\n\n`;
    out += `} // namespace ${machineName}\n`;

    return out;
}

export function generateCpHwContractString(machineName: string, requirementsContent: string): string {
    const upperMachineName = machineName.toUpperCase();
    const lowerMachineName = machineName.toLowerCase();
    const bspMethods = parseHwRequirementsHeader(requirementsContent);
    const irqs = parseIrqRequirements(requirementsContent);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED HARDWARE CONTRACT - DO NOT HAND-EDIT\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_HW_CONTRACT_HPP\n`;
    out += `#define ${upperMachineName}_HW_CONTRACT_HPP\n\n`;

    out += `#include "${hwRequirementsFile(lowerMachineName)}"\n`;
    out += `#include "fa_util.hpp"\n`;
    out += `#include <type_traits>\n`;
    out += `#include <utility>\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `template <typename HwPolicy>\n`;
    out += `struct HwContract {\n`;
    out += `private:\n`;

    bspMethods.forEach((m, idx) => {
        const declvalArgs = m.argTypes.map(t => `std::declval<${t}>()`).join(', ');
        const fn = `fn_${m.name}_${idx}`;
        out += `    template <typename T> using ${fn} = decltype(T::${m.name}(${declvalArgs}));\n`;
        // the return type as declared (a board returning bool for a size_t would otherwise pass by conversion)
        out += `    template <typename T> static constexpr bool returns_${m.name}_${idx}() {\n`;
        out += `        if constexpr (Fa::is_detected_v<${fn}, T>) {\n`;
        out += `            using Required = ${fn}<HwRequirements>;\n`;
        out += `            return std::is_void_v<Required> || std::is_same_v<std::decay_t<${fn}<T>>, std::decay_t<Required>>;\n`;
        out += `        } else {\n`;
        out += `            return true;   // reported as missing\n`;
        out += `        }\n`;
        out += `    }\n`;
    });
    irqs.forEach(name => {
        out += `    template <typename T> using irq_${name} = decltype(static_cast<int>(T::Irq::${name}));\n`;
    });

    out += `\npublic:\n`;
    out += `    static constexpr bool verify() {\n`;
    if (bspMethods.length === 0 && irqs.length === 0) {
        out += `        // No static driver prototypes declared in ${hwRequirementsFile(lowerMachineName)}\n`;
    } else {
        bspMethods.forEach((m, idx) => {
            out += `        static_assert(Fa::is_detected_v<fn_${m.name}_${idx}, HwPolicy>,\n`;
            out += `            "[${machineName} Contract Violation] the board must define: static ${m.returnType} ${m.name}(${m.rawArgs})");\n`;
            out += `        static_assert(returns_${m.name}_${idx}<HwPolicy>(),\n`;
            out += `            "[${machineName} Contract Violation] the board's ${m.name} must return ${m.returnType}, as required: static ${m.returnType} ${m.name}(${m.rawArgs})");\n`;
        });
        irqs.forEach(name => {
            out += `        static_assert(Fa::is_detected_v<irq_${name}, HwPolicy>,\n`;
            out += `            "[${machineName} Contract Violation] the board must define its interrupt: struct Irq { static constexpr IRQn_Type ${name} = ...; }");\n`;
        });
    }
    out += `        return true;\n`;
    out += `    }\n`;
    out += `};\n\n`;

    out += `} // namespace ${machineName}\n`;
    out += `#endif // ${upperMachineName}_HW_CONTRACT_HPP\n`;

    return out;
}

// ==========================================================================
// EVENTS: the structs are the user's (<name>_events.hpp, created once, new signals appended on export);
// the event list is the tool's (<name>_event_list.hpp: the Event variant and the names, every export).
// ==========================================================================
export const LEGACY_EVENTS_BANNER = 'AUTO-GENERATED FREEACTORS EVENT DEFINITIONS - DO NOT HAND-EDIT';

function machineSignals(hsm: any): string[] {
    return ((hsm.signals || []) as unknown[])
        .map(s => (typeof s === 'string' ? s : String((s as any)?.name ?? '')).trim())
        .filter(s => s.length > 0);
}

function eventsHeaderTop(machineName: string): string {
    let out = `// ==========================================================================\n`;
    out += `// EVENTS - ${machineName}\n`;
    out += `// Created once by FreeActors; this file is yours to edit (Export never overwrites it).\n`;
    out += `//\n`;
    out += `// One struct per signal of the model. Add the data an event carries as fields, with default values:\n`;
    out += `//     struct Temperature { int16_t celsius = 0; };\n`;
    out += `// Events are copied into queues and may be posted from interrupts: keep them small and plain\n`;
    out += `// (numbers, bool, fixed-size arrays; no pointers to temporary data, no std::string).\n`;
    out += `// A signal added to the model is appended here as an empty struct on the next export.\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n`;
    out += `#include <cstdint>\n\n`;
    out += `namespace ${machineName} {\n\n`;
    return out;
}

// The user-owned events header, as first created
export function generateCppEventsStub(jsonText: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    let out = eventsHeaderTop(machineName);
    const signals = machineSignals(hsm);
    if (signals.length === 0) {
        out += `// No signals in the model yet.\n`;
    }
    signals.forEach(sig => { out += `struct ${sig} {};\n`; });
    out += `\n} // namespace ${machineName}\n`;
    return out;
}

// Brings an existing events header up to date with the model:
//  - a header from before 0.0.8 (tool-owned, LEGACY_EVENTS_BANNER) is converted once into the user-owned form,
//    keeping the target structs as they were (with any fields added to them);
//  - signals of the model without a struct get an empty one, appended. Nothing is ever removed.
export function patchExistingEventsHeader(existing: string, jsonText: string):
        { updatedContent: string; converted: boolean; added: string[] } {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    let content = existing;
    let converted = false;

    if (content.includes(LEGACY_EVENTS_BANNER)) {
        // The target branch (#else ... #endif // FA_SIM) holds the structs as compiled for the firmware
        const target = /#else\s*\n([\s\S]*?)\n#endif\s*\/\/\s*FA_SIM/.exec(content);
        const plain = /namespace\s+\w+\s*\{([\s\S]*?)\/\/ --- Actor Event Variant/.exec(content);
        let body = (target?.[1] ?? plain?.[1] ?? '')
            .replace(/^\s*\/\/ =+\s*$/gm, '')
            .replace(/^\s*\/\/ (Signal & Event Payload Definitions|In FA_SIM, all events are zero-payload stubs.*|Generates empty struct default\.|If users need data payloads.*)\s*$/gm, '')
            .replace(/^\s*\/\/ No custom signals registered\.\s*$/gm, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        content = eventsHeaderTop(machineName) + (body ? body + '\n' : '') + `\n} // namespace ${machineName}\n`;
        converted = true;
    }

    const added: string[] = [];
    for (const sig of machineSignals(hsm)) {
        if (!new RegExp(`\\b(struct|class)\\s+${sig}\\b`).test(content)) {
            added.push(sig);
        }
    }
    if (added.length > 0) {
        const structs = added.map(sig => `struct ${sig} {};\n`).join('');
        const close = content.lastIndexOf('} // namespace');
        content = close >= 0
            ? content.slice(0, close) + structs + '\n' + content.slice(close)
            : content + '\n' + structs;
    }
    return { updatedContent: content, converted, added };
}

// ==========================================================================
// EVENT LAYOUTS: read from the user's events header (best effort), for the trace dictionary (fa-trace can post
// events with field values) and for static_asserts that catch a struct changed since the last export.
// Recognised fields: bool, (u)int8/16/32_t, int, unsigned, float, and fixed-size arrays of them, with an optional
// initialiser. Anything else in a struct (other types, methods, nested types) makes its layout unknown.
// Layout: natural alignment (Arm AAPCS; the same for these types on x86-64 hosts).
// ==========================================================================
export interface EventField { name: string; type: string; count: number; offset: number; }
export interface EventLayout { size: number; fields: EventField[]; }

const FIELD_TYPES: { [t: string]: { size: number; canonical: string } } = {
    'bool': { size: 1, canonical: 'bool' }, 'float': { size: 4, canonical: 'float' },
    'int8_t': { size: 1, canonical: 'int8_t' }, 'uint8_t': { size: 1, canonical: 'uint8_t' },
    'int16_t': { size: 2, canonical: 'int16_t' }, 'uint16_t': { size: 2, canonical: 'uint16_t' },
    'int32_t': { size: 4, canonical: 'int32_t' }, 'uint32_t': { size: 4, canonical: 'uint32_t' },
    'int': { size: 4, canonical: 'int32_t' }, 'unsigned': { size: 4, canonical: 'uint32_t' },
    'unsigned int': { size: 4, canonical: 'uint32_t' },
};

// The body of 'struct Name { ... };' (braces matched), or undefined
function structBody(header: string, name: string): string | undefined {
    const m = new RegExp(`\\bstruct\\s+${name}\\s*\\{`).exec(header);
    if (!m) return undefined;
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    for (; i < header.length && depth > 0; i++) {
        if (header[i] === '{') depth++;
        else if (header[i] === '}') depth--;
    }
    return depth === 0 ? header.slice(start, i - 1) : undefined;
}

// Layout of each signal's struct: an EventLayout, or null if the struct is missing or not understood
export function parseEventLayouts(eventsHeader: string, signals: string[]): Map<string, EventLayout | null> {
    const code = eventsHeader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const layouts = new Map<string, EventLayout | null>();
    for (const sig of signals) {
        const body = structBody(code, sig);
        if (body === undefined) { layouts.set(sig, null); continue; }
        const fields: EventField[] = [];
        let offset = 0, align = 1, ok = true;
        // Statements end with ';' (array initialisers like data[4]{} contain no ';')
        for (const raw of body.split(';').map(s => s.trim()).filter(s => s.length > 0)) {
            const f = /^(?:std::)?(bool|float|u?int(?:8|16|32)_t|unsigned int|unsigned|int)\s+([A-Za-z_]\w*)\s*(?:\[\s*(\d+)\s*\])?\s*(?:=\s*[^{}]+|\{[^{}]*\})?$/.exec(raw);
            const type = f ? FIELD_TYPES[f[1]!] : undefined;
            if (!f || !type) { ok = false; break; }
            const count = f[3] ? Number(f[3]) : 1;
            if (count < 1) { ok = false; break; }
            offset = Math.ceil(offset / type.size) * type.size;
            fields.push({ name: f[2]!, type: type.canonical, count, offset });
            offset += type.size * count;
            align = Math.max(align, type.size);
        }
        layouts.set(sig, ok ? { size: fields.length === 0 ? 0 : Math.ceil(offset / align) * align, fields } : null);
    }
    return layouts;
}

// The tool-owned event list: includes the user's structs, then the variant and the names for reflection.
// With the events header, it also pins the layouts it could read (fa-trace encodes fields with them).
export function generateCppEventListString(jsonText: string, eventsHeader?: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    const lowerMachineName = machineName.toLowerCase();
    const signals = machineSignals(hsm);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED FREEACTORS EVENT LIST - DO NOT HAND-EDIT (rewritten on every export)\n`;
    out += `// Machine: ${machineName}. The event structs are yours: ${lowerMachineName}_events.hpp\n`;
    out += `// ==========================================================================\n\n`;
    out += `#pragma once\n`;
    out += `#include <variant>\n`;
    out += `#include "fa_core.hpp"\n`;
    out += `#include "${lowerMachineName}_events.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `// Every event the machine accepts: the framework's signals, then the model's, in model order\n`;
    out += `using Event = std::variant<\n`;
    out += `    Fa::Enter_sig,\n`;
    out += `    Fa::Exit_sig,\n`;
    out += `    Fa::Init_sig,\n`;
    out += `    Fa::ExitToParent_sig`;
    signals.forEach(sig => { out += `,\n    ${sig}`; });
    out += `\n>;\n\n`;
    out += `} // namespace ${machineName}\n\n`;

    out += `// --- Event names, for the simulator and reflection ---\n`;
    out += `namespace Fa {\n`;
    signals.forEach(sig => {
        out += `    template <> struct EventDescriptor<${machineName}::${sig}> { static constexpr const char* name = "${sig}"; };\n`;
    });
    out += `} // namespace Fa\n`;

    if (eventsHeader !== undefined) {
        const layouts = parseEventLayouts(eventsHeader, signals);
        let checks = '';
        for (const [sig, layout] of layouts) {
            if (!layout) continue;
            const t = `${machineName}::${sig}`;
            const msg = `"${sig} changed since the last export: export again (fa-trace uses its field layout)"`;
            if (layout.fields.length === 0) {
                checks += `static_assert(std::is_empty_v<${t}>, ${msg});\n`;
                continue;
            }
            checks += `static_assert(sizeof(${t}) == ${layout.size}`;
            layout.fields.forEach(f => { checks += ` && offsetof(${t}, ${f.name}) == ${f.offset}`; });
            checks += `, ${msg});\n`;
        }
        if (checks) {
            out += `\n// --- Event layouts read at export (the trace dictionary has the same): a struct changed since then fails here ---\n`;
            out += `#include <cstddef>\n#include <type_traits>\n`;
            out += checks;
        }
    }
    return out;
}

export function generateCppBlueprintString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();

    const rawSignals = (hsm.signals || []) as string[];
    const normalizedSignals = rawSignals.map(s => s.trim()).filter(s => s.length > 0);

    const { states, guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED FREEACTORS HSM BLUEPRINT - DO NOT HAND-EDIT THIS FILE\n`;
    out += `// ==========================================================================\n\n`;
    
    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_HSM_HPP\n`;
    out += `#define ${upperMachineName}_HSM_HPP\n\n`;
    
    const lowerMachineName = machineName.toLowerCase();

    out += `#include "${lowerMachineName}_event_list.hpp"\n`;
    out += `#include "fa_core.hpp"\n`;
    out += `#include "fa_ops.hpp"\n`;
    out += `#include "fa_trace.hpp"\n`;
    out += `#include <array>\n`;
    out += `#ifdef FA_SIM\n`;
    out += `#include "fa_sim.hpp"   // host simulator only: MockMachine, REPL\n`;
    out += `#endif\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `    // --- 2. Predicate & Action Functors ---\n`;
    let elementIdCounter = 1;

    const guardEntries: { pascalName: string; rawMethod: string; id: number }[] = [];
    const actionEntries: { pascalName: string; rawMethod: string; id: number }[] = [];

    if (guardCatalog.size === 0) {
        out += `    // No conditional guards detected.\n`;
    } else {
        guardCatalog.forEach(({ pascalName, rawMethod }) => {
            const currentId = elementIdCounter++;
            guardEntries.push({ pascalName, rawMethod, id: currentId });
            out += `    struct ${pascalName} {\n`;
            out += `        template <typename M>\n`;
            out += `        static bool eval(M const &m) { return m.${rawMethod}(); }\n\n`;
            out += `        template <typename M, typename E>\n`;
            out += `        static bool eval(M const &m, E const &e) { return m.${rawMethod}(e); }\n`;
            out += `    };\n\n`;
        });
    }

    if (actionCatalog.size === 0) {
        out += `    // No action routines detected.\n`;
    } else {
        actionCatalog.forEach(({ pascalName, rawMethod }) => {
            const currentId = elementIdCounter++;
            actionEntries.push({ pascalName, rawMethod, id: currentId });
            out += `    struct ${pascalName} {\n`;
            out += `        template <typename M>\n`;
            out += `        static void execute(M &m) { m.${rawMethod}(); }\n\n`;
            out += `        template <typename M, typename E>\n`;
            out += `        static void execute(M &m, E const &e) { m.${rawMethod}(e); }\n`;
            out += `    };\n\n`;
        });
    }

    const guardPascalNames = guardEntries.map(g => g.pascalName);
    const actionPascalNames = actionEntries.map(a => a.pascalName);
    const stateTypeNames = states.map((s: any) => s.name).filter(Boolean);

    out += `    // --- 3. Reflective Type Catalogs ---\n`;
    out += `    using GuardCatalog = Fa::TypeList<${guardPascalNames.join(', ')}>;\n`;
    out += `    using ActionCatalog = Fa::TypeList<${actionPascalNames.join(', ')}>;\n\n`;

    out += `    // --- 4. Forward Declarations of States ---\n`;
    states.forEach((s: any) => {
        if (s.name) {
            out += `    struct ${s.name};\n`;
        }
    });
    out += `\n`;
    out += `    using StateCatalog = Fa::TypeList<${stateTypeNames.join(', ')}>;\n`;

    out += `    // --- 5. Structural Inheritance Tree ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;
        
        let parentClassName = "Fa::None";
        if (s.parent) {
            const parentObj = states.find((p: any) => p.id === s.parent);
            if (parentObj && parentObj.name) {
                parentClassName = parentObj.name;
            }
        }
        
        out += `    struct ${s.name} : public Fa::StateInterface<${s.name}, Event, ${parentClassName}> {\n`;
        out += `        template <typename M> static Fa::Status handle(M &m, Event const &e);\n`;
        out += `    };\n\n`;
    });

    out += `    // --- 6. State Handler Implementations ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;

        out += `    template <typename M>\n`;
        out += `    Fa::Status ${s.name}::handle(M &m, Event const &e) {\n`;
        out += `        Fa::Status status;\n`;
        out += `        switch(e.index()) {\n`;

        out += `            case Fa::get_index_v<Fa::Enter_sig, Event>:\n`;
        if (s.entry) {
            const raw = s.entry.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
            const entryWrapper = actionCatalog.get(raw)?.pascalName;
            if (entryWrapper) {
                out += `                Fa::Action<${entryWrapper}>::execute(m);\n`;
            }
        }
        out += `                status = Fa::Status::Handled;\n`;
        out += `                break;\n`;

        out += `            case Fa::get_index_v<Fa::Exit_sig, Event>:\n`;
        if (s.exit) {
            const raw = s.exit.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
            const exitWrapper = actionCatalog.get(raw)?.pascalName;
            if (exitWrapper) {
                out += `                Fa::Action<${exitWrapper}>::execute(m);\n`;
            }
        }
        out += `                status = Fa::Status::Handled;\n`;
        out += `                break;\n`;

        // Code for one reaction. An external transition (targetId set) hands its action to TransitionTo so
        // the engine runs it between the exit and entry actions (UML order); an internal reaction runs it in place.
        // A payload action (written without "()") receives the triggering signal, which must be known (signal != null).
        const reactionBody = (action: string, signal: string | null, targetId: string | null, indent: string): string => {
            let actionWrapper = "";
            let payloadSignal: string | null = null;
            if (action) {
                const rawAction = action.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                actionWrapper = actionCatalog.get(rawAction)?.pascalName || rawAction;
                if (signal && !action.endsWith('()')) payloadSignal = signal;
            }

            if (targetId !== null) {
                const targetObj = states.find((tgt: any) => tgt.id === targetId);
                const templateArgs = [targetObj ? targetObj.name : "Fa::None"];
                if (actionWrapper) templateArgs.push(actionWrapper);
                if (payloadSignal) templateArgs.push(payloadSignal);
                return `${indent}status = TransitionTo<${templateArgs.join(', ')}>(m);\n`;
            }

            let body = "";
            if (actionWrapper) {
                body += payloadSignal
                    ? `${indent}Fa::Action<${actionWrapper}>::execute(m, *std::get_if<${payloadSignal}>(&e));\n`
                    : `${indent}Fa::Action<${actionWrapper}>::execute(m);\n`;
            }
            return body + `${indent}status = Fa::Status::Handled;\n`;
        };

        const allTransitions = (s.transitions || []) as any[];
        const initTransitions = allTransitions.filter((t: any) => parseTrigger(t.event).signal === 'Init_sig');

        out += `            case Fa::get_index_v<Fa::Init_sig, Event>:\n`;
        if (initTransitions.length > 0) {
            const sortedInit = [...initTransitions].sort((a: any, b: any) => (a.guard && !b.guard) ? -1 : (!a.guard && b.guard) ? 1 : 0);
            let isFirst = true;
            sortedInit.forEach((t: any) => {
                const targetStateObj = states.find((tgt: any) => tgt.id === t.target);
                if (!targetStateObj || !targetStateObj.name) return;

                if (t.guard) {
                    const cleanGuard = t.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;
                    out += `                ${isFirst ? "if" : "else if"} (Fa::Guard<${guardWrapper}>::eval(m)) {\n`;
                } else {
                    out += `                ${isFirst ? "" : "else "}{\n`;
                }
                // Init_sig carries no payload, so an initial-transition action is always parameterless
                out += reactionBody(parseTrigger(t.event).action, null, t.target, '                    ');
                out += `                }\n`;
                isFirst = false;
            });
        } else {
            out += `                status = Fa::Status::Handled;\n`;
        }
        out += `                break;\n`;

        const reactionGroups: { [signal: string]: any[] } = {};

        allTransitions.filter((t: any) => parseTrigger(t.event).signal !== 'Init_sig').forEach((t: any) => {
            if (!t.event || !t.target) return;
            const { signal: signalToken, action: actionToken } = parseTrigger(t.event);

            if (!signalToken) return;

            (reactionGroups[signalToken] = reactionGroups[signalToken] || []).push({
                guard: t.guard ? t.guard.trim() : null,
                action: actionToken,
                target: t.target,
                isExternal: true
            });
        });

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const { signal: signalToken, action: actionToken } = parseTrigger(rawEv);
                if (!signalToken || signalToken === 'Init_sig') return;

                (reactionGroups[signalToken] = reactionGroups[signalToken] || []).push({
                    guard: null,
                    action: actionToken,
                    target: null,
                    isExternal: false
                });
            });
        }

        Object.keys(reactionGroups).forEach((signalToken) => {
            const list = reactionGroups[signalToken] || [];
            out += `            case Fa::get_index_v<${signalToken}, Event>:\n`;

            const sortedReactions = [...list].sort((a: any, b: any) => (a.guard && !b.guard) ? -1 : (!a.guard && b.guard) ? 1 : 0);
            
            let isFirstBranch = true;
            let holdsCatchallFallback = false;

            sortedReactions.forEach((react: any) => {
                const target = react.isExternal ? react.target : null;

                if (react.guard) {
                    const isParameterless = react.guard.endsWith('()');
                    const cleanGuard = react.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;

                    const guardEvalCall = isParameterless 
                        ? `Fa::Guard<${guardWrapper}>::eval(m)` 
                        : `Fa::Guard<${guardWrapper}>::eval(m, *std::get_if<${signalToken}>(&e))`;

                    out += `                ${isFirstBranch ? "if" : "else if"} (${guardEvalCall}) {\n`;
                    out += reactionBody(react.action, signalToken, target, '                    ');
                    out += `                }\n`;
                } else {
                    holdsCatchallFallback = true;
                    if (isFirstBranch) {
                        out += reactionBody(react.action, signalToken, target, '                ');
                    } else {
                        out += `                else {\n`;
                        out += reactionBody(react.action, signalToken, target, '                    ');
                        out += `                }\n`;
                    }
                }
                isFirstBranch = false;
            });

            if (!holdsCatchallFallback) {
                out += `                else {\n`;
                out += `                    status = Super(m, e);\n`;
                out += `                }\n`;
            }
            out += `                break;\n`;
        });

        out += `            default:\n`;
        out += `                status = Super(m, e);\n`;
        out += `                break;\n`;
        out += `        }\n`;
        out += `        return status;\n`;
        out += `    }\n\n`;
    });

    out += `} // namespace ${machineName}\n\n`;

    const reachMeta = generateUnifiedReachabilityMetadata(states, guardEntries);

    out += `// --- 7. Reflection Descriptor Specializations ---\n`;
    out += `namespace Fa {\n`;
    
    // States with is_leaf reflection
    states.forEach((s: any, idx: number) => {
        if (s.name) {
            const isLeaf = reachMeta.isLeafList[idx];
            out += `    template <> struct StateDescriptor<${machineName}::${s.name}> { static constexpr const char* name = "${s.name}"; static constexpr bool is_leaf = ${isLeaf ? 'true' : 'false'}; };\n`;
        }
    });

    // Guards
    guardEntries.forEach(g => {
        out += `    template <> struct GuardDescriptor<${machineName}::${g.pascalName}> { static constexpr const char* name = "${g.pascalName}"; static constexpr uint16_t id = ${g.id}; };\n`;
    });

    // Actions
    actionEntries.forEach(a => {
        out += `    template <> struct ActionDescriptor<${machineName}::${a.pascalName}> { static constexpr const char* name = "${a.pascalName}"; static constexpr uint16_t id = ${a.id}; };\n`;
    });

    out += `} // namespace Fa\n\n`;

    // --- 8. Compile-Time State Machine Traits Configuration ---
    const totalStates = states.length;
    const transCount = reachMeta.allTransitions.length;
    const guardCount = reachMeta.totalGuards;

    out += `// --- 8. Compile-Time State Machine Traits Configuration ---\n`;
    out += `#ifndef FA_SIM\n\n`;

    out += `// Embedded Target Hardware Traits Configuration (Zero Flash Overhead)\n`;
    out += `namespace ${machineName} {\n`;
    out += `    template <typename HwPolicy, typename Ctx>\n`;
    out += `    class Actor;\n`;
    out += `} // namespace ${machineName}\n\n`;

    out += `namespace Fa {\n`;
    out += `    template <typename HwPolicy, typename Ctx>\n`;
    out += `    struct HsmTraits<${machineName}::Actor<HwPolicy, Ctx>> {\n`;
    out += `        using StateCatalog = ${machineName}::StateCatalog;\n`;
    out += `        static constexpr auto InitialState = &${machineName}::ROOT::template Dispatch<${machineName}::Actor<HwPolicy, Ctx>>;\n`;
    out += `        static constexpr uint16_t InitialStateId = type_id_v<${machineName}::ROOT, StateCatalog>;\n`;
    out += `        static constexpr uint32_t ModelHash = 0x${modelHash(hsm).toString(16).padStart(8, '0')}u;   // reported in the trace HELLO frame\n`;
    out += `    };\n`;
    out += `} // namespace Fa\n\n`;

    out += `#else\n\n`;

    out += `// Host Simulation Sandbox Traits Configuration (Includes Reachability Topology)\n`;
    out += `namespace ${machineName} {\n`;
    out += `    using SimMachine = Fa::MockMachine<\n`;
    out += `        Event, \n`;
    out += `        GuardCatalog, \n`;
    out += `        ActionCatalog\n`;
    out += `    >;\n`;
    out += `} // namespace ${machineName}\n\n`;

    out += `namespace Fa {\n`;
    out += `    template <>\n`;
    out += `    struct HsmTraits<${machineName}::SimMachine> {\n`;
    out += `        using StateCatalog = ${machineName}::StateCatalog;\n`;
    out += `        using GuardCatalog = ${machineName}::GuardCatalog;\n`;
    out += `        using ActionCatalog = ${machineName}::ActionCatalog;\n`;
    out += `        static constexpr auto InitialState = &${machineName}::ROOT::template Dispatch<${machineName}::SimMachine>;\n`;
    out += `        static constexpr uint16_t InitialStateId = type_id_v<${machineName}::ROOT, StateCatalog>;\n\n`;

    out += `        // --- Static Unified Reachability Topology ---\n`;
    out += `        static constexpr size_t StateCount = ${totalStates};\n`;
    out += `        static constexpr size_t TotalTransitions = ${transCount};\n`;
    out += `        static constexpr size_t TotalGuards = ${guardCount};\n\n`;

    // 1. is_leaf_state array
    out += `        static constexpr std::array<bool, ${totalStates > 0 ? totalStates : 1}> is_leaf_state = {{\n`;
    reachMeta.isLeafList.forEach((isLeaf, idx) => {
        out += `            ${isLeaf ? 'true ' : 'false'}${idx < totalStates - 1 ? ',' : ''} // ID ${idx}: ${states[idx].name}\n`;
    });
    out += `        }};\n\n`;

    // 2. state_transition_ranges
    out += `        static constexpr std::array<Fa::IndexRange, ${totalStates > 0 ? totalStates : 1}> state_transition_ranges = {{\n`;
    reachMeta.stateRanges.forEach((r, idx) => {
        out += `            { ${r.start}, ${r.count} }${idx < totalStates - 1 ? ',' : ''} // ${states[idx].name}\n`;
    });
    out += `        }};\n\n`;

    // 3. transitions array
    out += `        static constexpr std::array<Fa::TransitionEdge, ${transCount > 0 ? transCount : 1}> transitions = {{\n`;
    if (transCount === 0) {
        out += `            { 0, 0, 0 }\n`;
    } else {
        reachMeta.allTransitions.forEach((e, idx) => {
            const sigExpr = e.isInit 
                ? `Fa::get_index_v<Fa::Init_sig, ${machineName}::Event>` 
                : `Fa::get_index_v<${machineName}::${e.signalName}, ${machineName}::Event>`;
            out += `            { ${e.fromStateId}, type_id_v<${machineName}::${e.toStateName}, StateCatalog>, ${sigExpr} }${idx < transCount - 1 ? ',' : ''} // ${states[e.fromStateId].name} --(${e.signalName})--> ${e.toStateName}\n`;
        });
    }
    out += `        }};\n\n`;

    // 4. transition_guards matrix (0: False, 1: True, 2: Don't Care)
    const matrixRows = transCount > 0 ? transCount : 1;
    const matrixCols = guardCount > 0 ? guardCount : 1;
    out += `        static constexpr std::array<std::array<int8_t, ${matrixCols}>, ${matrixRows}> transition_guards = {{\n`;
    if (transCount === 0) {
        out += `            {{ 2 }}\n`;
    } else {
        reachMeta.allTransitions.forEach((e, idx) => {
            const tritsStr = guardCount > 0 ? e.guardTrits.join(', ') : '2';
            out += `            {{ ${tritsStr} }}${idx < transCount - 1 ? ',' : ''}\n`;
        });
    }
    out += `        }};\n`;
    out += `    };\n`;
    out += `} // namespace Fa\n\n`;

    out += `#endif // FA_SIM\n\n`;
    out += `#endif // ${upperMachineName}_HSM_HPP\n`;
    return out;
}

// The actor's default task settings. Inside an application model the application generates them from the
// diagram (<app>_app.hpp defines FA_APP_MANAGED), so this block only applies to actors used on their own.
export function actorTraitsBlock(machineName: string): string {
    return `// ==========================================================================\n` +
           `// DEFAULT ACTOR TRAITS: used when no application model sets them (FA_APP_MANAGED, <app>_app.hpp)\n` +
           `// ==========================================================================\n` +
           `#ifndef FA_APP_MANAGED\n` +
           `namespace Fa {\n\n` +
           `template <typename HwPolicy, typename Ctx>\n` +
           `struct ActorTraits<${machineName}::Actor<HwPolicy, Ctx>> {\n` +
           `    static constexpr size_t QueueLength     = 8;   // Default FreeRTOS event queue depth\n` +
           `    static constexpr size_t StackDepthWords = 128; // Default stack size in words (512 bytes on ARM)\n` +
           `    static constexpr unsigned Priority      = 2;   // Default FreeRTOS task priority\n` +
           `    static constexpr const char* Name       = "${machineName}";\n` +
           `};\n\n` +
           `} // namespace Fa\n` +
           `#endif // FA_APP_MANAGED\n\n`;
}

// Wraps an existing default traits block in #ifndef FA_APP_MANAGED (actors from before 0.0.9)
function wrapActorTraitsBlock(content: string, machineName: string): string {
    const at = new RegExp(`struct\\s+ActorTraits\\s*<\\s*${machineName}::Actor`).exec(content);
    if (!at) return content;
    const start = content.lastIndexOf('namespace Fa {', at.index);
    const closing = content.indexOf('} // namespace Fa', at.index);
    if (start < 0 || closing < 0) return content;
    if (content.slice(Math.max(0, start - 200), start).includes('#ifndef FA_APP_MANAGED')) return content;
    const end = closing + '} // namespace Fa'.length;
    return content.slice(0, start) + '#ifndef FA_APP_MANAGED   // the application model sets the task (<app>_app.hpp)\n' +
           content.slice(start, end) + '\n#endif // FA_APP_MANAGED' + content.slice(end);
}

export function patchExistingActorHeader(
    existingContent: string,
    hsmJsonText: string
): { updatedContent: string; addedCount: number } {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(hsmJsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const { guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let updatedContent = existingContent;
    let addedCount = 0;

    // 0. The requirements file was renamed in 0.0.9 (<name>_bsp_policy.hpp -> <name>_hw_requirements.hpp)
    {
        const lower = machineName.toLowerCase();
        updatedContent = updatedContent.split(`#include "${legacyHwRequirementsFile(lower)}"`).join(`#include "${hwRequirementsFile(lower)}"`);
    }

    // 1. Modernize legacy base class names
    if (updatedContent.includes('Fa::ActiveObject')) {
        updatedContent = updatedContent.replace(/Fa::ActiveObject/g, 'Fa::Hsm');
    }

    // 2. Upgrade single-param template class signature to dual-param (HwPolicy + Ctx)
    // Matches: template <typename HwPolicy ...> class Actor : public Fa::Hsm<Actor<HwPolicy>, Event>
    const oldClassDeclRegex = /template\s*<\s*typename\s+HwPolicy(?:\s*=\s*DefaultHwPolicy)?\s*>\s*class\s+Actor\s*:\s*public\s+Fa::Hsm\s*<\s*Actor\s*<\s*HwPolicy\s*>\s*,\s*Event\s*>/g;
    if (oldClassDeclRegex.test(updatedContent)) {
        updatedContent = updatedContent.replace(
            oldClassDeclRegex,
            `template <typename HwPolicy, typename Ctx = Fa::NullContext>\nclass Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event>`
        );
    }

    // The board is selected by the application (AppTraits::Platform), so the actor has no default HwPolicy
    updatedContent = updatedContent.replace(
        /(template\s*<\s*typename\s+HwPolicy)\s*=\s*DefaultHwPolicy(\s*,\s*typename\s+Ctx)/,
        '$1$2'
    );

    // Also upgrade any explicit base constructor call in the class constructor:
    // Fa::Hsm<Actor<HwPolicy>, Event>() -> Fa::Hsm<Actor<HwPolicy, Ctx>, Event>()
    updatedContent = updatedContent.replace(
        /Fa::Hsm\s*<\s*Actor\s*<\s*HwPolicy\s*>\s*,\s*Event\s*>\s*\(\s*\)/g,
        `Fa::Hsm<Actor<HwPolicy, Ctx>, Event>()`
    );

    // 3. Ensure essential type aliases exist in the public section
    const hasEventType = /\busing\s+EventType\s*=\s*Event\s*;/.test(updatedContent);
    const hasPolicy = /\busing\s+Policy\s*=\s*HwPolicy\s*;/.test(updatedContent);
    const hasContext = /\busing\s+Context\s*=\s*Ctx\s*;/.test(updatedContent);

    if (!hasEventType || !hasPolicy || !hasContext) {
        let aliasInjections = "";
        if (!hasPolicy) {
            aliasInjections += `    using Policy = HwPolicy;\n`;
        }
        if (!hasContext) {
            aliasInjections += `    using Context = Ctx;     // Inspected by Fa::Hsm base for schedule / post\n`;
        }
        if (!hasEventType) {
            aliasInjections += `    using EventType = Event; // Inspected by Fa::Application compile-time router\n`;
        }

        if (/\bpublic\s*:/.test(updatedContent)) {
            updatedContent = updatedContent.replace(/\bpublic\s*:/, `public:\n${aliasInjections}`);
        }
    }

    // 3b. Actor API block (post/schedule/cancel without 'this->', Hw::, IDE declarations); user code is untouched
    if (!updatedContent.includes(ACTOR_API_MARKER) && /\bpublic\s*:/.test(updatedContent)) {
        updatedContent = updatedContent.replace(/\bpublic\s*:[ \t]*\n/, `public:\n${generateActorApiBlock()}\n`);
    }

    // 4. Scan for missing guards
    const missingSnippets: string[] = [];

    guardCatalog.forEach(item => {
        const exists = new RegExp(`\\b${item.rawMethod}\\s*\\(`).test(updatedContent);
        if (!exists) {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                missingSnippets.push(
                    `    bool ${item.rawMethod}() const {\n` +
                    `        // TODO: Implement guard logic\n` +
                    `        return true;\n` +
                    `    }\n`
                );
            }
            item.payloadEvents.forEach(sig => {
                missingSnippets.push(
                    `    bool ${item.rawMethod}(${sig} const &/*e*/) const {\n` +
                    `        // TODO: Implement guard logic against event payload\n` +
                    `        return true;\n` +
                    `    }\n`
                );
            });
        }
    });

    // 5. Scan for missing actions
    actionCatalog.forEach(item => {
        const exists = new RegExp(`\\b${item.rawMethod}\\s*\\(`).test(updatedContent);
        if (!exists) {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                missingSnippets.push(
                    `    void ${item.rawMethod}() {\n` +
                    `        // TODO: Implement action routine using HwPolicy\n` +
                    `    }\n`
                );
            }
            item.payloadEvents.forEach(sig => {
                missingSnippets.push(
                    `    void ${item.rawMethod}(${sig} const &/*e*/) {\n` +
                    `        // TODO: Process payload from ${sig} using HwPolicy\n` +
                    `    }\n`
                );
            });
        }
    });

    // 6. Append newly discovered methods to class
    if (missingSnippets.length > 0) {
        addedCount += missingSnippets.length;
        const insertionText = `\n    // --- Newly Discovered HSM Handlers ---\n` + missingSnippets.join('\n') + '\n';

        if (/\bprivate\s*:/.test(updatedContent)) {
            updatedContent = updatedContent.replace(/\bprivate\s*:/, `${insertionText}private:`);
        } else {
            const classEndMatch = /(class\s+Actor[\s\S]*?)(\n\s*\};\s*\n\s*\}\s*\/\/\s*namespace)/;
            if (classEndMatch.test(updatedContent)) {
                updatedContent = updatedContent.replace(classEndMatch, `$1${insertionText}$2`);
            }
        }
    }

    // 7. Upgrade existing single-param ActorTraits specialization to dual-param
    const oldTraitsRegex = /template\s*<\s*typename\s+HwPolicy\s*>\s*struct\s+ActorTraits\s*<\s*([a-zA-Z0-9_]+)::Actor\s*<\s*HwPolicy\s*>\s*>/g;
    if (oldTraitsRegex.test(updatedContent)) {
        updatedContent = updatedContent.replace(
            oldTraitsRegex,
            `template <typename HwPolicy, typename Ctx>\nstruct ActorTraits<$1::Actor<HwPolicy, Ctx>>`
        );
    }

    // 8. Default task settings: added if missing, wrapped in #ifndef FA_APP_MANAGED if from before 0.0.9
    const traitsPattern = new RegExp(`struct\\s+ActorTraits\\s*<\\s*${machineName}::Actor`);
    if (!traitsPattern.test(updatedContent)) {
        const traitsBlock = '\n' + actorTraitsBlock(machineName);
        const lastEndifIdx = updatedContent.lastIndexOf('#endif');
        if (lastEndifIdx !== -1) {
            updatedContent = updatedContent.slice(0, lastEndifIdx) + traitsBlock + updatedContent.slice(lastEndifIdx);
        } else {
            updatedContent += '\n' + traitsBlock;
        }
    } else {
        updatedContent = wrapActorTraitsBlock(updatedContent, machineName);
    }

    return { updatedContent, addedCount };
}

// The actor's API block: post/schedule/cancel without 'this->' and the board as Hw::. Under FA_IDE (set only
// for clangd by the generated .clangd) the same names are declared concretely, so the IDE can complete them
// with their parameters and list the board functions of HwRequirements. The compiler never sees FA_IDE.
export const ACTOR_API_MARKER = 'using Base = Fa::Hsm<Actor<HwPolicy, Ctx>, Event>;';
export function generateActorApiBlock(): string {
    let out = `    // Actor API: call post(...), schedule(...), cancel(...) directly, and the board as Hw::\n`;
    out += `    ${ACTOR_API_MARKER}\n`;
    out += `#ifdef FA_IDE\n`;
    out += `    // Seen only by the IDE (clangd, via .clangd): concrete declarations for completion. Never compiled.\n`;
    out += `    template <typename E> bool schedule(E const& event, uint16_t ms, bool periodic = false);   // (re)start E's timer\n`;
    out += `    template <typename E> void cancel(E const& event);                                         // stop E's timer\n`;
    out += `    template <typename E> void post(E const& event);                                           // send to its actor\n`;
    out += `    using Hw = HwRequirements;\n`;
    out += `#else\n`;
    out += `    using Base::post;\n`;
    out += `    using Base::schedule;\n`;
    out += `    using Base::cancel;\n`;
    out += `    using Hw = HwPolicy;\n`;
    out += `#endif\n`;
    return out;
}

// clangd configuration for an exported project (created once): FA_IDE for completion, nothing for the compiler
export const CLANGD_FILENAME = '.clangd';
export function generateClangdConfigString(): string {
    return `# clangd only (never the compiler): FA_IDE gives FreeActors actors concrete declarations for completion\n` +
           `CompileFlags:\n` +
           `  Add: [-DFA_IDE]\n`;
}

export function generateCppConcreteHeaderStub(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();
    const lowerMachineName = machineName.toLowerCase();

    const { guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let out = `// ==========================================================================\n`;
    out += `// CONCRETE ACTIVE OBJECT TEMPLATE IMPLEMENTATION HEADER\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_ACTOR_HPP\n`;
    out += `#define ${upperMachineName}_ACTOR_HPP\n\n`;

    out += `#include "${lowerMachineName}_events.hpp"\n`;
    out += `#include "${lowerMachineName}_hsm.hpp"\n`;
    out += `#include "${hwRequirementsFile(lowerMachineName)}"\n`;
    out += `#include "${lowerMachineName}_hw_contract.hpp"\n`;
    out += `#include "fa_util.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `// HwPolicy: the board (selected once via AppTraits::Platform), or TestBsp in actor tests.\n`;
    out += `template <typename HwPolicy, typename Ctx = Fa::NullContext>\n`;
    out += `class Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event> {\n`;
    out += `    // Compile-time contract enforcement\n`;
    out += `    static_assert(HwContract<HwPolicy>::verify());\n\n`;

    out += `public:\n`;
    out += generateActorApiBlock() + `\n`;
    out += `    using Policy = HwPolicy;\n`;
    out += `    using Context = Ctx;     // Inspected by Fa::Hsm base for schedule / post\n`;
    out += `    using EventType = Event; // Inspected by Fa::Application compile-time router\n\n`;
    out += `    static constexpr uint8_t instance_id = Fa::InstanceIdOf<HwPolicy>::value;\n`;
    out += `#ifdef FA_SIM\n`;
    out += `    static constexpr const char* instance_name = Fa::InstanceNameOf<HwPolicy>::value;\n`;
    out += `#endif\n\n`;

    out += `    Actor() : Fa::Hsm<Actor<HwPolicy, Ctx>, Event>() {}\n`;
    out += `    ~Actor() = default;\n\n`;

    out += `    // --- Guard Predicates (Actor Logic) ---\n`;
    if (guardCatalog.size === 0) {
        out += `    // No guard conditions registered.\n`;
    } else {
        guardCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `    bool ${item.rawMethod}() const {\n`;
                out += `        // TODO: Implement guard logic\n`;
                out += `        return true;\n`;
                out += `    }\n\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `    bool ${item.rawMethod}(${sig} const &/*e*/) const {\n`;
                out += `        // TODO: Implement guard logic against event payload\n`;
                out += `        return true;\n`;
                out += `    }\n\n`;
            });
        });
    }

    out += `    // --- Action Handlers (Actor Logic) ---\n`;
    if (actionCatalog.size === 0) {
        out += `    // No action routines registered.\n`;
    } else {
        actionCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `    void ${item.rawMethod}() {\n`;
                out += `        // TODO: Implement action routine, e.g. Hw::set_led(true); schedule(Timeout{}, 500);\n`;
                out += `    }\n\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `    void ${item.rawMethod}(${sig} const &/*e*/) {\n`;
                out += `        // TODO: Process payload from ${sig}, e.g. with Hw:: board functions\n`;
                out += `    }\n\n`;
            });
        });
    }

    out += `private:\n`;
    out += `    // User private fields (state variables, counters, timers)\n`;
    out += `};\n\n`;

    out += `} // namespace ${machineName}\n\n`;

    out += actorTraitsBlock(machineName);

    out += `#endif // ${upperMachineName}_ACTOR_HPP\n`;

    return out;
}

function generateCppConcreteSourceStub(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";

    const { guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let out = `// ==========================================================================\n`;
    out += `// CONCRETE ACTIVE OBJECT IMPLEMENTATION SOURCE\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#include "${machineName.toLowerCase()}_actor.hpp"\n`;
    out += `#include <iostream>\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `Actor::Actor()\n`;
    out += `    : Fa::Hsm<Actor, Event>() {\n`;
    out += `    // Initialize hardware peripherals, FreeRTOS queue configurations, or timer handles\n`;
    out += `}\n\n`;

    out += `// --- Guard Predicate Implementations ---\n`;
    if (guardCatalog.size === 0) {
        out += `// No guard conditions registered.\n\n`;
    } else {
        guardCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `bool Actor::${item.rawMethod}() const {\n`;
                out += `    // TODO: Return condition evaluation\n`;
                out += `    return true;\n`;
                out += `}\n\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `bool Actor::${item.rawMethod}(${sig} const &/*e*/) const {\n`;
                out += `    // TODO: Return condition evaluation against payload\n`;
                out += `    return true;\n`;
                out += `}\n\n`;
            });
        });
    }

    out += `// --- Action Handler Implementations ---\n`;
    if (actionCatalog.size === 0) {
        out += `// No action routines registered.\n\n`;
    } else {
        actionCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `void Actor::${item.rawMethod}() {\n`;
                out += `    // TODO: Implement peripheral trigger or operational logic\n`;
                out += `}\n\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `void Actor::${item.rawMethod}(${sig} const &/*e*/) {\n`;
                out += `    // TODO: Process payload from ${sig}\n`;
                out += `}\n\n`;
            });
        });
    }

    out += `} // namespace ${machineName}\n`;

    return out;
}

export function generateCppCliSimulatorString(jsonText: string): string {
    let hsm = { name: "ActorMachine" };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();

    let out = `// ==========================================================================\n`;
    out += `// FREEACTORS CLI HOST SIMULATOR - DESKTOP REPL\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#define FA_SIM\n`;
    out += `#include "${lowerMachineName}_hsm.hpp"\n`;
    out += `#include "fa_sim.hpp"\n`;
    out += `#include <iostream>\n\n`;

    out += `int main() {\n`;
    out += `    ${machineName}::SimMachine machine;\n\n`;

    out += `    Fa::SimRunner<${machineName}::SimMachine> runner(machine);\n\n`;

    out += `    runner.run_repl();\n\n`;

    out += `    return 0;\n`;
    out += `}\n`;

    return out;
}

export function generateCMakeListsString(jsonText: string): string {
    let hsm = { name: "ActorMachine" };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();

    let out = `cmake_minimum_required(VERSION 3.14)\n`;
    out += `project(${lowerMachineName}_sim LANGUAGES CXX)\n\n`;

    out += `set(CMAKE_CXX_STANDARD 17)\n`;
    out += `set(CMAKE_CXX_STANDARD_REQUIRED ON)\n`;
    out += `set(CMAKE_CXX_EXTENSIONS OFF)\n`;
    out += `set(CMAKE_EXPORT_COMPILE_COMMANDS ON)   # build/compile_commands.json: code completion (clangd)\n\n`;

    out += `# Cross-compiling (the "firmware" preset): the firmware, from the application's Target, instead of the host targets\n`;
    out += `if(CMAKE_CROSSCOMPILING)\n`;
    out += `    if(NOT EXISTS \${CMAKE_CURRENT_SOURCE_DIR}/${FIRMWARE_CMAKE_FILENAME})\n`;
    out += `        message(FATAL_ERROR "No firmware build yet: describe the board's Target in the application diagram, then Export Application")\n`;
    out += `    endif()\n`;
    out += `    include(\${CMAKE_CURRENT_SOURCE_DIR}/${FIRMWARE_CMAKE_FILENAME})\n`;
    out += `    return()\n`;
    out += `endif()\n\n`;

    out += `include_directories(\n`;
    out += `    \${CMAKE_CURRENT_SOURCE_DIR}\n`;
    out += `    \${CMAKE_CURRENT_SOURCE_DIR}/freeactors\n`;
    out += `)\n\n`;

    out += `add_executable(${lowerMachineName}_sim\n`;
    out += `    main.cpp\n`;
    out += `)\n\n`;

    out += `if(UNIX AND NOT APPLE)\n`;
    out += `    target_link_libraries(${lowerMachineName}_sim PRIVATE pthread)\n`;
    out += `endif()\n\n`;

    out += `# Host tests (model + actor), generated by FreeActors. Run: ctest --test-dir build\n`;
    out += `include(\${CMAKE_CURRENT_SOURCE_DIR}/${TESTS_CMAKE_FILENAME})\n`;

    return out;
}

// ==========================================================================
// TRACE DICTIONARY (tool-owned <name>_trace.json): turns the numbers in trace records back into names
// ==========================================================================
export function generateTraceDictionaryString(jsonText: string, eventsHeader?: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    const { states, guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);
    const signals = machineSignals(hsm);

    // Descriptor ids are numbered exactly as in generateCppBlueprintString: guards first, then actions, from 1
    let nextId = 1;
    const guards: { [id: string]: string } = {};
    guardCatalog.forEach(({ pascalName }) => { guards[String(nextId++)] = pascalName; });
    const actions: { [id: string]: string } = {};
    actionCatalog.forEach(({ pascalName }) => { actions[String(nextId++)] = pascalName; });

    const dictionary = {
        format: "freeactors-trace-dictionary",
        version: 1,
        machine: machineName,
        model_hash: `0x${modelHash(hsm).toString(16).padStart(8, '0')}`,
        events: ["Enter_sig", "Exit_sig", "Init_sig", "ExitToParent_sig", ...signals],   // Event variant order
        states: states.map((s: any) => s.name).filter(Boolean),                          // StateCatalog order
        guards,
        actions,
        // Field layouts of the model's events (null: not understood, fa-trace takes raw bytes for it)
        ...(eventsHeader !== undefined ? { payloads: Object.fromEntries(parseEventLayouts(eventsHeader, signals)) } : {})
    };
    return JSON.stringify(dictionary, null, 2) + "\n";
}

// ==========================================================================
// DESIGNER TEST SCAFFOLDING (doctest + fa_test.hpp)
// ==========================================================================

export const TESTS_CMAKE_FILENAME = 'freeactors_tests.cmake';

function machineNameOf(hsm: any): string {
    return hsm && hsm.name ? String(hsm.name).replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
}

// The leaf the machine settles in after start(): follow unguarded initial transitions down from ROOT.
function initialLeafStateName(hsm: any, machineName: string): string {
    const { states } = extractCatalogs(hsm, machineName);
    let current: any = states.find((s: any) => s.name === "ROOT");
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        const init = ((current.transitions || []) as any[])
            .find((t: any) => parseTrigger(t.event).signal === 'Init_sig' && !t.guard);
        const next = init ? states.find((s: any) => s.id === init.target) : undefined;
        if (!next) break;
        current = next;
    }
    return current ? current.name : "ROOT";
}

export function generateCppModelTestStub(jsonText: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    const lower = machineName.toLowerCase();
    const initialLeaf = initialLeafStateName(hsm, machineName);
    const { guardCatalog } = extractCatalogs(hsm, machineName);
    const signals = ((hsm.signals || []) as string[]).map(s => s.trim()).filter(s => s.length > 0);
    const exampleSignal = signals[0] || "YourSignal";
    const exampleGuard = guardCatalog.values().next().value?.pascalName;

    let out = `// ==========================================================================\n`;
    out += `// MODEL TESTS - ${machineName}\n`;
    out += `// Created once by FreeActors; this file is yours to edit (Export never overwrites it).\n`;
    out += `//\n`;
    out += `// Tests the state machine as drawn: guards are switches you set (m.set_guard<Guard>(true)),\n`;
    out += `// actions are only recorded by name. No actor code is needed.\n`;
    out += `// A trace step is an action ("Entry_${initialLeaf}") or a transition ("A->B"), in execution order.\n`;
    out += `//\n`;
    out += `// Build & run:  cmake -B build && cmake --build build && ctest --test-dir build\n`;
    out += `// ==========================================================================\n\n`;

    out += `#define FA_SIM\n`;
    out += `#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\n`;
    out += `#include "doctest.h"\n\n`;
    out += `#include "${lower}_hsm.hpp"\n`;
    out += `#include "fa_test.hpp"\n\n`;

    out += `using namespace ${machineName};\n`;
    out += `using Fa::test::in_state;\n`;
    out += `using Fa::test::send;\n`;
    out += `using Fa::test::start;\n`;
    out += `using Fa::test::steps;\n`;
    out += `using Fa::test::trace;\n\n`;

    out += `TEST_CASE("${machineName} starts in ${initialLeaf}") {\n`;
    out += `    SimMachine m;\n`;
    out += `    start(m);\n`;
    out += `    CHECK(in_state<${initialLeaf}>(m));\n`;
    out += `}\n\n`;

    out += `// Example scenario - copy, rename and adapt it to your model:\n`;
    out += `//\n`;
    out += `// TEST_CASE("describe the behaviour") {\n`;
    out += `//     SimMachine m;\n`;
    out += `//     start(m);\n`;
    if (exampleGuard) {
        out += `//     m.set_guard<${exampleGuard}>(true);\n`;
    }
    out += `//     send(m, ${exampleSignal}{});                                  // drive the machine\n`;
    out += `//     CHECK(trace(m, ${exampleSignal}{}) == steps{"FROM->TO", "Exit_FROM", "Entry_TO"});  // exact steps\n`;
    out += `//     CHECK(in_state<SOME_STATE>(m));                          // where it ended up\n`;
    out += `// }\n`;
    out += `//\n`;
    out += `// Signals: ${signals.length > 0 ? signals.join(', ') : '(none)'}\n`;
    out += `// Guards:  ${guardCatalog.size > 0 ? [...guardCatalog.values()].map(g => g.pascalName).join(', ') : '(none)'}\n`;
    return out;
}

// Tool-owned host test double for the BSP requirements file; rewritten on every export so it always
// provides exactly the driver functions the hardware contract checks for.
export function generateCppTestBspString(machineName: string, requirementsContent: string): string {
    const lower = machineName.toLowerCase();
    const upper = machineName.toUpperCase();
    const bspMethods = parseHwRequirementsHeader(requirementsContent);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED HOST TEST DOUBLE - DO NOT HAND-EDIT (rewritten on every export)\n`;
    out += `// Machine: ${machineName}   Source: ${hwRequirementsFile(lower)}\n`;
    out += `//\n`;
    out += `// TestBsp provides every driver function declared in ${hwRequirementsFile(lower)}:\n`;
    out += `//   - each call is recorded with its arguments in Fa::test::log(), e.g. "set_led(true)"\n`;
    out += `//   - a function returning a value returns <name>_result, which the test sets\n`;
    out += `//   - Fa::test::reset<TestBsp>() clears the log and restores the default results\n`;
    out += `// For custom behaviour, derive from TestBsp and redefine just that static function.\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upper}_TEST_BSP_HPP\n`;
    out += `#define ${upper}_TEST_BSP_HPP\n\n`;
    out += `#include <cstdint>\n`;
    out += `#include "${hwRequirementsFile(lower)}"\n`;
    out += `#include "fa_test.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `struct TestBsp {\n`;
    if (bspMethods.length === 0) {
        out += `    // No driver functions are declared in ${hwRequirementsFile(lower)} yet.\n`;
    }
    const resettable: string[] = [];
    bspMethods.forEach(m => {
        const params = m.argTypes.map((t, i) => `${t} a${i}`).join(', ');
        const recordArgs = [`"${m.name}"`, ...m.argTypes.map((_, i) => `a${i}`)].join(', ');
        if (m.returnType === 'void') {
            out += `    static void ${m.name}(${params}) { Fa::test::record(${recordArgs}); }\n`;
        } else {
            out += `    static inline ${m.returnType} ${m.name}_result{};\n`;
            out += `    static ${m.returnType} ${m.name}(${params}) { Fa::test::record(${recordArgs}); return ${m.name}_result; }\n`;
            resettable.push(`${m.name}_result = {};`);
        }
    });
    const irqs = parseIrqRequirements(requirementsContent);
    if (irqs.length > 0) {
        out += `\n    struct Irq {   // stand-in interrupt numbers (no NVIC on the host)\n`;
        irqs.forEach((name, i) => { out += `        static constexpr int ${name} = ${i};\n`; });
        out += `    };\n`;
    }
    out += `\n    static void reset() {${resettable.length > 0 ? ' ' + resettable.join(' ') + ' ' : ''}}\n`;
    out += `};\n\n`;
    out += `} // namespace ${machineName}\n\n`;
    out += `#endif // ${upper}_TEST_BSP_HPP\n`;
    return out;
}

export function generateCppActorTestStub(jsonText: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    const lower = machineName.toLowerCase();
    const initialLeaf = initialLeafStateName(hsm, machineName);
    const signals = ((hsm.signals || []) as string[]).map(s => s.trim()).filter(s => s.length > 0);
    const exampleSignal = signals[0] || "YourSignal";

    let out = `// ==========================================================================\n`;
    out += `// ACTOR TESTS - ${machineName}\n`;
    out += `// Created once by FreeActors; this file is yours to edit (Export never overwrites it).\n`;
    out += `//\n`;
    out += `// Runs your real Actor (the guards and actions in ${lower}_actor.hpp) on the PC:\n`;
    out += `//   - TestBsp (generated in ${lower}_test_bsp.hpp) stands in for the board: driver calls are recorded,\n`;
    out += `//     and functions that return a value return TestBsp::<name>_result, which you set\n`;
    out += `//   - Fa::test::RecordingContext records the actor's post(...) and schedule(...)\n`;
    out += `//   - Fa::test::log() is one ordered timeline of both, e.g. {"set_led(true)", "post Done"}\n`;
    out += `//\n`;
    out += `// Build & run:  cmake -B build && cmake --build build && ctest --test-dir build\n`;
    out += `// ==========================================================================\n\n`;

    out += `#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN\n`;
    out += `#include "doctest.h"\n\n`;
    out += `#include "${lower}_actor.hpp"\n`;
    out += `#include "${lower}_test_bsp.hpp"\n`;
    out += `#include "fa_test.hpp"\n\n`;

    out += `using namespace ${machineName};\n`;
    out += `using Fa::test::in_state;\n`;
    out += `using Fa::test::send;\n`;
    out += `using Fa::test::start;\n`;
    out += `using Fa::test::steps;\n\n`;

    out += `using TestActor = Actor<TestBsp, Fa::test::RecordingContext>;\n\n`;

    out += `TEST_CASE("${machineName} actor starts in ${initialLeaf}") {\n`;
    out += `    Fa::test::reset<TestBsp>();\n`;
    out += `    TestActor actor;\n`;
    out += `    start(actor);\n`;
    out += `    CHECK(in_state<${initialLeaf}>(actor));\n`;
    out += `}\n\n`;

    out += `// Example - check what your actions do to the outside world:\n`;
    out += `//\n`;
    out += `// TEST_CASE("describe the behaviour") {\n`;
    out += `//     Fa::test::reset<TestBsp>();                // clean log, default driver results\n`;
    out += `//     TestBsp::read_button_result = true;        // inputs the actor will read (if declared)\n`;
    out += `//     TestActor actor;\n`;
    out += `//     start(actor);\n`;
    out += `//     send(actor, ${exampleSignal}{});\n`;
    out += `//     CHECK(Fa::test::log() == steps{"set_led(true)", "schedule Tick 500ms"});\n`;
    out += `// }\n`;
    return out;
}

// Tool-owned; rewritten on every export. The project's CMakeLists.txt includes it.
export function generateTestsCMakeString(jsonText: string): string {
    const machineName = machineNameOf(JSON.parse(jsonText));
    const lower = machineName.toLowerCase();

    let out = `# ==========================================================================\n`;
    out += `# AUTO-GENERATED FREEACTORS HOST TESTS - DO NOT HAND-EDIT (rewritten on every export)\n`;
    out += `# Machine: ${machineName}\n`;
    out += `# Included from CMakeLists.txt:  include(\${CMAKE_CURRENT_SOURCE_DIR}/${TESTS_CMAKE_FILENAME})\n`;
    out += `# Test sources live in tests/ and are yours to edit.\n`;
    out += `# ==========================================================================\n\n`;

    out += `enable_testing()\n\n`;
    out += `foreach(fa_test ${lower}_model_test ${lower}_actor_test)\n`;
    out += `    add_executable(\${fa_test} \${CMAKE_CURRENT_LIST_DIR}/tests/\${fa_test}.cpp)\n`;
    out += `    target_include_directories(\${fa_test} PRIVATE\n`;
    out += `        \${CMAKE_CURRENT_LIST_DIR}\n`;
    out += `        \${CMAKE_CURRENT_LIST_DIR}/freeactors\n`;
    out += `    )\n`;
    out += `    target_compile_features(\${fa_test} PRIVATE cxx_std_17)\n`;
    out += `    add_test(NAME \${fa_test} COMMAND \${fa_test})\n`;
    out += `endforeach()\n`;
    return out;
}

// A new state machine: the ROOT state and the given signals (the HSM editor's skeleton for an empty file, and the
// machine Export Application creates for an actor drawn without one)
export function defaultHsmModel(name: string, signals: string[]): object {
    return {
        name,
        signals: [...signals],
        guards: [],
        actions: [],
        states: [
            { id: "STATE_ROOT", name: "ROOT", x: 50, y: 50, width: 700, height: 500, entry: "entry_ROOT()", exit: "exit_ROOT()" }
        ]
    };
}

export interface StateMachineExport { name: string; message: string; hint?: string; }

// Export of one state machine (the HSM editor's Export, and Export Application for every actor): the tool-owned
// files rewritten, the user-owned ones created once or patched. Throws on an invalid model, before writing anything.
async function exportStateMachine(context: vscode.ExtensionContext, folderUri: vscode.Uri, jsonText: string): Promise<StateMachineExport> {
    validateHsmModel(jsonText);
    let hsmName = "ActorMachine";
    try {
        const parsed = JSON.parse(jsonText);
        if (parsed.name) hsmName = parsed.name.replace(/[^a-zA-Z0-9_]/g, "");
    } catch (e) {}
    const lower = hsmName.toLowerCase();
    const at = (file: string) => vscode.Uri.joinPath(folderUri, file);
    const write = (file: string, content: string) => vscode.workspace.fs.writeFile(at(file), stringToUint8Array(content));
    const eventsFilename = `${lower}_events.hpp`;
    const blueprintFilename = `${lower}_hsm.hpp`;
    const requirementsFilename = hwRequirementsFile(lower);
    const hwContractFilename = `${lower}_hw_contract.hpp`;
    const actorHeaderFilename = `${lower}_actor.hpp`;

    // Hardware requirements (user-owned). Before 0.0.9 they were <name>_bsp_policy.hpp: renamed once, unchanged
    let renamedNote = '';
    if (!(await fileExists(at(requirementsFilename))) && (await fileExists(at(legacyHwRequirementsFile(lower))))) {
        await vscode.workspace.fs.rename(at(legacyHwRequirementsFile(lower)), at(requirementsFilename));
        renamedNote = ` Renamed ${legacyHwRequirementsFile(lower)} to ${requirementsFilename} (same content).`;
    }
    const existingRequirements = await readFileIfExists(at(requirementsFilename));
    const requirementsExisted = existingRequirements !== undefined;
    const requirements = existingRequirements ?? generateCppHwRequirementsStub(hsmName);
    if (!requirementsExisted) await write(requirementsFilename, requirements);

    // Event structs (user-owned): created once; new signals appended; a pre-0.0.8 header converted once
    const existingEvents = await readFileIfExists(at(eventsFilename));
    let eventsNote = '';
    let eventsContent: string;
    if (existingEvents === undefined) {
        eventsContent = generateCppEventsStub(jsonText);
        await write(eventsFilename, eventsContent);
    } else {
        const eventsPatch = patchExistingEventsHeader(existingEvents, jsonText);
        eventsContent = eventsPatch.updatedContent;
        if (eventsPatch.updatedContent !== existingEvents) await write(eventsFilename, eventsPatch.updatedContent);
        if (eventsPatch.converted) {
            eventsNote = ` '${eventsFilename}' is now yours to edit: add fields to your events there.`;
        } else if (eventsPatch.added.length > 0) {
            eventsNote = ` Added ${eventsPatch.added.join(', ')} to '${eventsFilename}'.`;
        }
    }

    // Tool-owned: the event list, the blueprint, the hardware contract
    await write(`${lower}_event_list.hpp`, generateCppEventListString(jsonText, eventsContent));
    await write(blueprintFilename, generateCppBlueprintString(jsonText));
    await write(hwContractFilename, generateCpHwContractString(hsmName, requirements));

    // Actor header (user-owned): created if missing, else the missing handlers appended
    const existingActorText = await readFileIfExists(at(actorHeaderFilename));
    const actorExisted = existingActorText !== undefined;
    let addedMethodsCount = 0;
    if (actorExisted) {
        const patchResult = patchExistingActorHeader(existingActorText, jsonText);
        if (patchResult.updatedContent !== existingActorText) await write(actorHeaderFilename, patchResult.updatedContent);
        addedMethodsCount = patchResult.addedCount;
    } else {
        await write(actorHeaderFilename, generateCppConcreteHeaderStub(jsonText));
    }

    // Host simulator and project files, created once
    if (!(await fileExists(at('main.cpp')))) await write('main.cpp', generateCppCliSimulatorString(jsonText));
    if (!(await fileExists(at('CMakeLists.txt')))) await write('CMakeLists.txt', generateCMakeListsString(jsonText));
    if (!(await fileExists(at(CLANGD_FILENAME)))) await write(CLANGD_FILENAME, generateClangdConfigString());

    // Host tests: the sources are created once (user-owned); the CMake include is tool-owned
    const testsDirUri = at('tests');
    const testStubs: [string, () => string][] = [
        [`${lower}_model_test.cpp`, () => generateCppModelTestStub(jsonText)],
        [`${lower}_actor_test.cpp`, () => generateCppActorTestStub(jsonText)],
    ];
    const createdTests: string[] = [];
    for (const [filename, generate] of testStubs) {
        const uri = vscode.Uri.joinPath(testsDirUri, filename);
        if (!(await fileExists(uri))) {
            await vscode.workspace.fs.createDirectory(testsDirUri);
            await vscode.workspace.fs.writeFile(uri, stringToUint8Array(generate()));
            createdTests.push(`tests/${filename}`);
        }
    }
    await write(TESTS_CMAKE_FILENAME, generateTestsCMakeString(jsonText));
    await write(`${lower}_test_bsp.hpp`, generateCppTestBspString(hsmName, requirements));
    await write(`${lower}_trace.json`, generateTraceDictionaryString(jsonText, eventsContent));

    await copyFrameworkFilesToWorkspace(context, folderUri);

    // Projects created before test support have a CMakeLists.txt without the include
    const cmakeText = await readFileIfExists(at('CMakeLists.txt'));
    const hint = cmakeText !== undefined && !cmakeText.includes(TESTS_CMAKE_FILENAME)
        ? `🧪 Host tests are ready${createdTests.length > 0 ? ` (${createdTests.join(', ')})` : ''}. ` +
          `To build them, add this line to CMakeLists.txt: include(\${CMAKE_CURRENT_SOURCE_DIR}/${TESTS_CMAKE_FILENAME})`
        : undefined;

    let message: string;
    if (!actorExisted || !requirementsExisted) {
        message = `🚀 Export complete! Generated '${blueprintFilename}', '${hwContractFilename}', and starter '${actorHeaderFilename}'.`;
    } else if (addedMethodsCount > 0) {
        message = `✨ Preserved custom code & appended ${addedMethodsCount} newly discovered HSM method(s) to '${actorHeaderFilename}'!${eventsNote}${renamedNote}`;
    } else {
        message = `🔄 Synchronized '${blueprintFilename}' and '${hwContractFilename}'. Custom code untouched.${eventsNote}${renamedNote}`;
    }
    return hint === undefined ? { name: hsmName, message } : { name: hsmName, message, hint };
}

class FreeActorsEditorProvider implements vscode.CustomTextEditorProvider {

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new FreeActorsEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(FreeActorsEditorProvider.viewType, provider);
    }

    private static readonly viewType = 'freeactors.hsmEditor';

    constructor(
        private readonly context: vscode.ExtensionContext
    ) { }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media')
            ]
        };

        if (document.getText().trim().length === 0) {
            const rawFilename = document.uri.fsPath.split(/[\\/]/).pop() || "ActorMachine";
            const segments = rawFilename.split('.');
            const firstSegment = segments[0] || "ActorMachine";
            
            const baseName = firstSegment.replace(/[^a-zA-Z0-9_]/g, "") || "ActorMachine";
            const sanitizedName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
            
            const defaultSkeleton = defaultHsmModel(sanitizedName, []);
            await this.updateTextDocument(document, JSON.stringify(defaultSkeleton, null, 2));
        }

        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

        function updateWebview() {
            webviewPanel.webview.postMessage({
                type: 'update',
                text: document.getText()
            });
        }

        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === document.uri.toString()) {
                updateWebview();
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });

        webviewPanel.webview.onDidReceiveMessage(async messageEvent => {
            switch (messageEvent.type) {
                case 'ready':
                    updateWebview();
                    return;
                case 'documentEdit':
                    this.updateTextDocument(document, messageEvent.jsonText);
                    return;
                // One source of truth for events (section 7.2 of docs/design/app-diagram.md): the applications follow
                case 'renameSignal': {
                    const folderUri = vscode.Uri.joinPath(document.uri, '..');
                    try {
                        vscode.window.showInformationMessage(await renameSignalEverywhere(folderUri, document.uri.path.split('/').pop()!,
                                                                                         String(messageEvent.from), String(messageEvent.to)));
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`❌ Rename refused: ${e.message}`);
                    }
                    return;
                }
                case 'signalDeleted': {
                    const note = await removeSignalEverywhere(vscode.Uri.joinPath(document.uri, '..'), document.uri.path.split('/').pop()!,
                                                              String(messageEvent.name));
                    if (note) vscode.window.showInformationMessage(note);
                    return;
                }
                case 'exportCppBlueprint': {
                    try {
                        const result = await exportStateMachine(this.context, vscode.Uri.joinPath(document.uri, '..'), document.getText());
                        if (result.hint) vscode.window.showInformationMessage(result.hint);
                        vscode.window.showInformationMessage(result.message);
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`❌ Export failed: ${err.message}`);
                    }
                    return;
                }
            }
        });

        updateWebview();
    }

    private updateTextDocument(document: vscode.TextDocument, updatedJsonText: string) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            updatedJsonText
        );
        return vscode.workspace.applyEdit(edit);
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const mediaUri = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'style.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'main.js'));
        const canvasUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'canvas.js'));
        const htmlUri = vscode.Uri.joinPath(mediaUri, 'webview.html');

        const htmlRaw = await vscode.workspace.fs.readFile(htmlUri);
        const htmlText = uint8ArrayToString(htmlRaw);

        return htmlText
            .replace('{{styleUri}}', styleUri.toString())
            .replace('{{canvasUri}}', canvasUri.toString())
            .replace('{{scriptUri}}', scriptUri.toString());
    }
}