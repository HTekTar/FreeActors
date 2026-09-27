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
    'doctest.h'
];

export async function copyFrameworkFilesToWorkspace(context: vscode.ExtensionContext, folderUri: vscode.Uri) {
    const destinationDirUri = vscode.Uri.joinPath(folderUri, 'freeactors');
    const sourceDirUri = vscode.Uri.joinPath(context.extensionUri, 'freeactors_lib');

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
    } catch (error: any) {
        vscode.window.showErrorMessage(`❌ Framework Sync Failed: ${error.message}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(FreeActorsEditorProvider.register(context));
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

function parseBspPolicyHeader(fileContent: string): BspMethodSignature[] {
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

export function generateCppBspPolicyStarterStub(machineName: string): string {
    const lower = machineName.toLowerCase();
    let out = `// ==========================================================================\n`;
    out += `// HARDWARE REQUIREMENTS - ${machineName} actor\n`;
    out += `// Created once by FreeActors; this file is yours to edit.\n`;
    out += `//\n`;
    out += `// Declare here the static driver functions the ${machineName} actor calls through HwPolicy.\n`;
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
    out += `    // static void set_led(bool on);\n`;
    out += `    // static uint16_t read_adc(uint8_t channel);\n`;
    out += `};\n\n`;
    out += `} // namespace ${machineName}\n`;

    return out;
}

export function generateCpHwContractString(machineName: string, bspPolicyContent: string): string {
    const upperMachineName = machineName.toUpperCase();
    const lowerMachineName = machineName.toLowerCase();
    const bspMethods = parseBspPolicyHeader(bspPolicyContent);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED HARDWARE POLICY CONTRACT - DO NOT HAND-EDIT\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_HW_CONTRACT_HPP\n`;
    out += `#define ${upperMachineName}_HW_CONTRACT_HPP\n\n`;

    out += `#include "${lowerMachineName}_bsp_policy.hpp"\n`;
    out += `#include "fa_util.hpp"\n`;
    out += `#include <utility>\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `template <typename HwPolicy>\n`;
    out += `struct HwContract {\n`;
    out += `private:\n`;

    bspMethods.forEach((m, idx) => {
        const declvalArgs = m.argTypes.map(t => `std::declval<${t}>()`).join(', ');
        out += `    template <typename T> using fn_${m.name}_${idx} = decltype(T::${m.name}(${declvalArgs}));\n`;
    });

    out += `\npublic:\n`;
    out += `    static constexpr bool verify() {\n`;
    if (bspMethods.length === 0) {
        out += `        // No static driver prototypes declared in ${lowerMachineName}_bsp_policy.hpp\n`;
    } else {
        bspMethods.forEach((m, idx) => {
            out += `        static_assert(Fa::is_detected_v<fn_${m.name}_${idx}, HwPolicy>,\n`;
            out += `            "[${machineName} Actor Contract Violation] HwPolicy must define: static ${m.returnType} ${m.name}(${m.rawArgs})");\n`;
        });
    }
    out += `        return true;\n`;
    out += `    }\n`;
    out += `};\n\n`;

    out += `} // namespace ${machineName}\n`;
    out += `#endif // ${upperMachineName}_HW_CONTRACT_HPP\n`;

    return out;
}

export function generateCppEventsHeaderString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [] };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();

    const rawSignals = (hsm.signals || []) as string[];
    const normalizedSignals = rawSignals.map(s => s.trim()).filter(s => s.length > 0);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED FREEACTORS EVENT DEFINITIONS - DO NOT HAND-EDIT\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_EVENTS_HPP\n`;
    out += `#define ${upperMachineName}_EVENTS_HPP\n\n`;

    out += `#include <cstdint>\n`;
    out += `#include <variant>\n`;
    out += `#include "fa_core.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `// ==========================================================================\n`;
    out += `// Signal & Event Payload Definitions\n`;
    out += `// In FA_SIM, all events are zero-payload stubs for CLI/REPL simulation.\n`;
    out += `// ==========================================================================\n`;

    out += `#ifdef FA_SIM\n\n`;
    if (normalizedSignals.length === 0) {
        out += `// No custom signals registered.\n`;
    } else {
        normalizedSignals.forEach(sig => {
            out += `struct ${sig} {};\n`;
        });
    }
    out += `\n#else\n\n`;

    if (normalizedSignals.length === 0) {
        out += `// No custom signals registered.\n`;
    } else {
        normalizedSignals.forEach(sig => {
            // Generates empty struct default.
            // If users need data payloads on target, they can add fields here or use payload types.
            out += `struct ${sig} {};\n`;
        });
    }
    out += `\n#endif // FA_SIM\n\n`;

    out += `// --- Actor Event Variant ---\n`;
    out += `using Event = std::variant<\n`;
    out += `    Fa::Enter_sig,\n`;
    out += `    Fa::Exit_sig,\n`;
    out += `    Fa::Init_sig,\n`;
    out += `    Fa::ExitToParent_sig`;
    normalizedSignals.forEach(sig => {
        out += `,\n    ${sig}`;
    });
    out += `\n>;\n\n`;

    out += `} // namespace ${machineName}\n\n`;

    out += `// --- Event Descriptor Specializations for Reflection ---\n`;
    out += `namespace Fa {\n`;
    normalizedSignals.forEach(sig => {
        out += `    template <> struct EventDescriptor<${machineName}::${sig}> { static constexpr const char* name = "${sig}"; };\n`;
    });
    out += `} // namespace Fa\n\n`;

    out += `#endif // ${upperMachineName}_EVENTS_HPP\n`;
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

    out += `#include "${lowerMachineName}_events.hpp"\n`;
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

function patchExistingActorHeader(
    existingContent: string,
    hsmJsonText: string
): { updatedContent: string; addedCount: number } {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(hsmJsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const { guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let updatedContent = existingContent;
    let addedCount = 0;

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
            aliasInjections += `    using Context = Ctx;     // Inspected by Fa::Hsm base for this->schedule / this->post\n`;
        }
        if (!hasEventType) {
            aliasInjections += `    using EventType = Event; // Inspected by Fa::Application compile-time router\n`;
        }

        if (/\bpublic\s*:/.test(updatedContent)) {
            updatedContent = updatedContent.replace(/\bpublic\s*:/, `public:\n${aliasInjections}`);
        }
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

    // 8. If ActorTraits is completely missing, append the default configuration
    const traitsPattern = new RegExp(`struct\\s+ActorTraits\\s*<\\s*${machineName}::Actor`);
    if (!traitsPattern.test(updatedContent)) {
        const traitsBlock = 
            `\n// ==========================================================================\n` +
            `// DEFAULT ACTOR TRAITS CONFIGURATION\n` +
            `// Application-level overrides can be defined in app_cfg.hpp\n` +
            `// ==========================================================================\n` +
            `namespace Fa {\n\n` +
            `template <typename HwPolicy, typename Ctx>\n` +
            `struct ActorTraits<${machineName}::Actor<HwPolicy, Ctx>> {\n` +
            `    static constexpr size_t QueueLength     = 8;   // Default FreeRTOS event queue depth\n` +
            `    static constexpr size_t StackDepthWords = 128; // Default stack size in words (512 bytes on ARM)\n` +
            `    static constexpr unsigned Priority      = 2;   // Default FreeRTOS task priority\n` +
            `    static constexpr const char* Name       = "${machineName}";\n` +
            `};\n\n` +
            `} // namespace Fa\n\n`;

        const lastEndifIdx = updatedContent.lastIndexOf('#endif');
        if (lastEndifIdx !== -1) {
            updatedContent = updatedContent.slice(0, lastEndifIdx) + traitsBlock + updatedContent.slice(lastEndifIdx);
        } else {
            updatedContent += '\n' + traitsBlock;
        }
    }

    return { updatedContent, addedCount };
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
    out += `#include "${lowerMachineName}_bsp_policy.hpp"\n`;
    out += `#include "${lowerMachineName}_hw_contract.hpp"\n`;
    out += `#include "fa_util.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `// HwPolicy: the board (selected once via AppTraits::Platform), or TestBsp in actor tests.\n`;
    out += `template <typename HwPolicy, typename Ctx = Fa::NullContext>\n`;
    out += `class Actor : public Fa::Hsm<Actor<HwPolicy, Ctx>, Event> {\n`;
    out += `    // Compile-time contract enforcement\n`;
    out += `    static_assert(HwContract<HwPolicy>::verify());\n\n`;

    out += `public:\n`;
    out += `    using Policy = HwPolicy;\n`;
    out += `    using Context = Ctx;     // Inspected by Fa::Hsm base for this->schedule / this->post\n`;
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
                out += `        // TODO: Implement action routine using HwPolicy\n`;
                out += `    }\n\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `    void ${item.rawMethod}(${sig} const &/*e*/) {\n`;
                out += `        // TODO: Process payload from ${sig} using HwPolicy\n`;
                out += `    }\n\n`;
            });
        });
    }

    out += `private:\n`;
    out += `    // User private fields (state variables, counters, timers)\n`;
    out += `};\n\n`;

    out += `} // namespace ${machineName}\n\n`;

    // --- Default Actor Traits Configuration ---
    out += `// ==========================================================================\n`;
    out += `// DEFAULT ACTOR TRAITS CONFIGURATION\n`;
    out += `// Application-level overrides can be defined in app_cfg.hpp\n`;
    out += `// ==========================================================================\n`;
    out += `namespace Fa {\n\n`;
    out += `template <typename HwPolicy, typename Ctx>\n`;
    out += `struct ActorTraits<${machineName}::Actor<HwPolicy, Ctx>> {\n`;
    out += `    static constexpr size_t QueueLength     = 8;   // Default FreeRTOS event queue depth\n`;
    out += `    static constexpr size_t StackDepthWords = 128; // Default stack size in words (512 bytes on ARM)\n`;
    out += `    static constexpr unsigned Priority      = 2;   // Default FreeRTOS task priority\n`;
    out += `    static constexpr const char* Name       = "${machineName}";\n`;
    out += `};\n\n`;
    out += `} // namespace Fa\n\n`;

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
    out += `set(CMAKE_CXX_EXTENSIONS OFF)\n\n`;

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
export function generateTraceDictionaryString(jsonText: string): string {
    const hsm = JSON.parse(jsonText);
    const machineName = machineNameOf(hsm);
    const { states, guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);
    const signals = ((hsm.signals || []) as string[]).map(s => s.trim()).filter(s => s.length > 0);

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
        actions
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
export function generateCppTestBspString(machineName: string, bspPolicyContent: string): string {
    const lower = machineName.toLowerCase();
    const upper = machineName.toUpperCase();
    const bspMethods = parseBspPolicyHeader(bspPolicyContent);

    let out = `// ==========================================================================\n`;
    out += `// AUTO-GENERATED HOST TEST DOUBLE - DO NOT HAND-EDIT (rewritten on every export)\n`;
    out += `// Machine: ${machineName}   Source: ${lower}_bsp_policy.hpp\n`;
    out += `//\n`;
    out += `// TestBsp provides every driver function declared in ${lower}_bsp_policy.hpp:\n`;
    out += `//   - each call is recorded with its arguments in Fa::test::log(), e.g. "set_led(true)"\n`;
    out += `//   - a function returning a value returns <name>_result, which the test sets\n`;
    out += `//   - Fa::test::reset<TestBsp>() clears the log and restores the default results\n`;
    out += `// For custom behaviour, derive from TestBsp and redefine just that static function.\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upper}_TEST_BSP_HPP\n`;
    out += `#define ${upper}_TEST_BSP_HPP\n\n`;
    out += `#include <cstdint>\n`;
    out += `#include "${lower}_bsp_policy.hpp"\n`;
    out += `#include "fa_test.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `struct TestBsp {\n`;
    if (bspMethods.length === 0) {
        out += `    // No driver functions are declared in ${lower}_bsp_policy.hpp yet.\n`;
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
            
            const defaultSkeleton = {
                name: sanitizedName,
                signals: [],
                guards: [],
                actions: [],
                states: [
                    {
                        id: "STATE_ROOT",
                        name: "ROOT",
                        x: 50,
                        y: 50,
                        width: 700,
                        height: 500,
                        entry: "entry_ROOT()",
                        exit: "exit_ROOT()"
                    }
                ]
            };
            
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
                
                    case 'exportCppBlueprint': {
                        const jsonText = document.getText();
                        let hsmName = "ActorMachine";
                        try {
                            const parsed = JSON.parse(jsonText);
                            if (parsed.name) hsmName = parsed.name.replace(/[^a-zA-Z0-9_]/g, "");
                        } catch (e) {}
    
                        const lowerHsmName = hsmName.toLowerCase();
                        const eventsFilename = `${lowerHsmName}_events.hpp`;
                        const blueprintFilename = `${lowerHsmName}_hsm.hpp`;
                        const bspPolicyFilename = `${lowerHsmName}_bsp_policy.hpp`;
                        const hwContractFilename = `${lowerHsmName}_hw_contract.hpp`;
                        const actorHeaderFilename = `${lowerHsmName}_actor.hpp`;
                        const mainFilename = `main.cpp`;
                        const cmakeFilename = `CMakeLists.txt`;
    
                        const folderUri = vscode.Uri.joinPath(document.uri, '..');
                        const eventsUri = vscode.Uri.joinPath(folderUri, eventsFilename);
                        const blueprintUri = vscode.Uri.joinPath(folderUri, blueprintFilename);
                        const bspPolicyUri = vscode.Uri.joinPath(folderUri, bspPolicyFilename);
                        const hwContractUri = vscode.Uri.joinPath(folderUri, hwContractFilename);
                        const actorHeaderUri = vscode.Uri.joinPath(folderUri, actorHeaderFilename);
                        const mainUri = vscode.Uri.joinPath(folderUri, mainFilename);
                        const cmakeUri = vscode.Uri.joinPath(folderUri, cmakeFilename);
    
                        try {
                            // 0. Reject invalid models before anything is written
                            validateHsmModel(jsonText);

                            // 1. Read or generate starter BSP Policy header (User-owned)
                            const existingBsp = await readFileIfExists(bspPolicyUri);
                            const bspExists = existingBsp !== undefined;
                            let bspContent = existingBsp ?? "";
                            if (!bspExists) {
                                bspContent = generateCppBspPolicyStarterStub(hsmName);
                                await vscode.workspace.fs.writeFile(bspPolicyUri, stringToUint8Array(bspContent));
                            }
    
                            // 2. Overwrite HSM Blueprint & HwContract (100% Tool-owned)
                            const cppEvents = generateCppEventsHeaderString(jsonText); // <-- NEW
                            await vscode.workspace.fs.writeFile(eventsUri, stringToUint8Array(cppEvents));

                            const cppBlueprint = generateCppBlueprintString(jsonText);
                            await vscode.workspace.fs.writeFile(blueprintUri, stringToUint8Array(cppBlueprint));
    
                            const cppHwContract = generateCpHwContractString(hsmName, bspContent);
                            await vscode.workspace.fs.writeFile(hwContractUri, stringToUint8Array(cppHwContract));
    
                            // 3. Actor Header (User-owned): create if missing, or patch missing handlers
                            const existingActorText = await readFileIfExists(actorHeaderUri);
                            const actorExists = existingActorText !== undefined;
                            let addedMethodsCount = 0;
                            if (actorExists) {
                                const patchResult = patchExistingActorHeader(existingActorText, jsonText);
                                if (patchResult.updatedContent !== existingActorText) {
                                    await vscode.workspace.fs.writeFile(actorHeaderUri, stringToUint8Array(patchResult.updatedContent));
                                }
                                addedMethodsCount = patchResult.addedCount;
                            } else {
                                const freshActorHeader = generateCppConcreteHeaderStub(jsonText);
                                await vscode.workspace.fs.writeFile(actorHeaderUri, stringToUint8Array(freshActorHeader));
                            }

                            // 4. Host Simulator stubs
                            if (!(await fileExists(mainUri))) {
                                await vscode.workspace.fs.writeFile(mainUri, stringToUint8Array(generateCppCliSimulatorString(jsonText)));
                            }
                            if (!(await fileExists(cmakeUri))) {
                                await vscode.workspace.fs.writeFile(cmakeUri, stringToUint8Array(generateCMakeListsString(jsonText)));
                            }
    
                            // 5. Host tests: test sources are created once (user-owned); the CMake include is tool-owned
                            const testsDirUri = vscode.Uri.joinPath(folderUri, 'tests');
                            const modelTestFilename = `${lowerHsmName}_model_test.cpp`;
                            const actorTestFilename = `${lowerHsmName}_actor_test.cpp`;
                            const testStubs: [string, () => string][] = [
                                [modelTestFilename, () => generateCppModelTestStub(jsonText)],
                                [actorTestFilename, () => generateCppActorTestStub(jsonText)],
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
                            await vscode.workspace.fs.writeFile(
                                vscode.Uri.joinPath(folderUri, TESTS_CMAKE_FILENAME),
                                stringToUint8Array(generateTestsCMakeString(jsonText)));
                            await vscode.workspace.fs.writeFile(
                                vscode.Uri.joinPath(folderUri, `${lowerHsmName}_test_bsp.hpp`),
                                stringToUint8Array(generateCppTestBspString(hsmName, bspContent)));
                            await vscode.workspace.fs.writeFile(
                                vscode.Uri.joinPath(folderUri, `${lowerHsmName}_trace.json`),
                                stringToUint8Array(generateTraceDictionaryString(jsonText)));

                            await copyFrameworkFilesToWorkspace(this.context, folderUri);

                            // Projects created before test support have a CMakeLists.txt without the include
                            const cmakeText = await readFileIfExists(cmakeUri);
                            if (cmakeText !== undefined && !cmakeText.includes(TESTS_CMAKE_FILENAME)) {
                                vscode.window.showInformationMessage(
                                    `🧪 Host tests are ready${createdTests.length > 0 ? ` (${createdTests.join(', ')})` : ''}. ` +
                                    `To build them, add this line to CMakeLists.txt: include(\${CMAKE_CURRENT_SOURCE_DIR}/${TESTS_CMAKE_FILENAME})`
                                );
                            }
    
                            // 6. User Feedback
                            if (!actorExists || !bspExists) {
                                vscode.window.showInformationMessage(
                                    `🚀 Export complete! Generated '${blueprintFilename}', '${hwContractFilename}', and starter '${actorHeaderFilename}'.`
                                );
                            } else if (addedMethodsCount > 0) {
                                vscode.window.showInformationMessage(
                                    `✨ Preserved custom code & appended ${addedMethodsCount} newly discovered HSM method(s) to '${actorHeaderFilename}'!`
                                );
                            } else {
                                vscode.window.showInformationMessage(
                                    `🔄 Synchronized '${blueprintFilename}' and '${hwContractFilename}'. Custom code untouched.`
                                );
                            }
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
        const htmlUri = vscode.Uri.joinPath(mediaUri, 'webview.html');

        const htmlRaw = await vscode.workspace.fs.readFile(htmlUri);
        const htmlText = uint8ArrayToString(htmlRaw);

        return htmlText
            .replace('{{styleUri}}', styleUri.toString())
            .replace('{{scriptUri}}', scriptUri.toString());
    }
}