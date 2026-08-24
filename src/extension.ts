import * as vscode from 'vscode';

function uint8ArrayToString(arr: Uint8Array): string {
    return new (globalThis as any).TextDecoder('utf-8').decode(arr);
}

function stringToUint8Array(str: string): Uint8Array {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        arr[i] = str.charCodeAt(i) & 0xFF;
    }
    return arr;
}

export async function copyFrameworkFilesToWorkspace(context: vscode.ExtensionContext, folderUri: vscode.Uri) {
    const destinationDirUri = vscode.Uri.joinPath(folderUri, 'freeactors');
    
    // Read directly from the root freeactors_lib folder
    const sourceDirUri = vscode.Uri.joinPath(context.extensionUri, 'freeactors_lib');
    
    const frameworkFiles = [
        'fa_core.hpp', 
        'fa_mempool.hpp', 
        'fa_timeEvent.hpp', 
        'fa_util.hpp', 
        'fa_ops.hpp', 
        'fa_trace.hpp',
        'fa_sim.hpp',
        'fa_actor.hpp',
        'fa_repl.hpp'
    ];

    try {
        await vscode.workspace.fs.createDirectory(destinationDirUri);
        for (const filename of frameworkFiles) {
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
                const signalToken = (t.event && typeof t.event === 'string') 
                    ? (t.event.trim().split('/')[0] || "").trim() 
                    : "";
                const isInit = signalToken === 'Init_sig';
                const payloadEvent = isInit ? undefined : signalToken;

                if (t.guard) registerGuard(t.guard, payloadEvent);

                if (t.event && typeof t.event === 'string' && t.event.includes('/')) {
                    const actionPart = t.event.split('/')[1] || "";
                    registerAction(actionPart, payloadEvent);
                }
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const cleanEv = rawEv.replace('·', '').trim();
                const signalToken = (cleanEv.split('/')[0] || "").trim();
                if (cleanEv.includes('/')) {
                    const actionPart = cleanEv.split('/')[1] || "";
                    registerAction(actionPart, signalToken);
                }
            });
        }
    });

    return { states, guardCatalog, actionCatalog };
}

function generateCppBlueprintString(jsonText: string): string {
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
    
    out += `#include "fa_core.hpp"\n`;
    out += `#include "fa_ops.hpp"\n`;
    out += `#include "fa_sim.hpp"\n`;
    out += `#include "fa_trace.hpp"\n`;
    out += `#include <iostream>\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `#ifdef FA_SIM\n`;
    out += `    // --- 1. User-Defined Event Signals (Simulation Mode Stubs) ---\n`;
    if (normalizedSignals.length === 0) {
        out += `    // No custom signals registered.\n`;
    } else {
        normalizedSignals.forEach(sig => {
            out += `    struct ${sig} {};\n`;
        });
    }
    out += `#else\n`;
    out += `    // --- 1. Forward Declarations for Embedded Target Event Payloads ---\n`;
    if (normalizedSignals.length === 0) {
        out += `    // No custom signals registered.\n`;
    } else {
        normalizedSignals.forEach(sig => {
            out += `    struct ${sig};\n`;
        });
    }
    out += `#endif // FA_SIM\n\n`;

    out += `    using Event = std::variant<\n`;
    out += `        Fa::Enter_sig,\n`;
    out += `        Fa::Exit_sig,\n`;
    out += `        Fa::Init_sig,\n`;
    out += `        Fa::ExitToParent_sig`;
    normalizedSignals.forEach(sig => {
        out += `,\n        ${sig}`;
    });
    out += `\n    >;\n\n`;

    out += `} // namespace ${machineName}\n\n`;

    out += `// --- 1b. Event Descriptor Specializations for Reflection ---\n`;
    out += `namespace Fa {\n`;
    if (normalizedSignals.length === 0) {
        out += `    // No custom signals registered.\n`;
    } else {
        normalizedSignals.forEach(sig => {
            out += `    template <> struct EventDescriptor<${machineName}::${sig}> { static constexpr const char* name = "${sig}"; };\n`;
        });
    }
    out += `} // namespace Fa\n\n`;

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

        const allTransitions = (s.transitions || []) as any[];
        const initTransitions = allTransitions.filter((t: any) => t.event === 'Init_sig');
        
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
                    out += `                    status = TransitionTo<${targetStateObj.name}>(m);\n`;
                    out += `                }\n`;
                    isFirst = false;
                } else {
                    out += `                ${isFirst ? "" : "else "}{\n`;
                    out += `                    status = TransitionTo<${targetStateObj.name}>(m);\n`;
                    out += `                }\n`;
                }
            });
        } else {
            out += `                status = Fa::Status::Handled;\n`;
        }
        out += `                break;\n`;

        const reactionGroups: { [signal: string]: any[] } = {};

        allTransitions.filter((t: any) => t.event !== 'Init_sig').forEach((t: any) => {
            if (!t.event || !t.target) return;
            let signalToken = t.event.trim().split('/')[0].trim();
            let actionToken = t.event.includes('/') ? t.event.split('/')[1].trim() : "";
            
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
                const cleanEv = rawEv.replace('·', '').trim();
                if (!cleanEv || cleanEv.startsWith('Init_sig')) return;

                const localParts = cleanEv.split('/');
                const signalToken = (localParts[0] || "").trim();
                const actionToken = cleanEv.includes('/') ? (localParts[1] || "").trim() : "";
                
                if (!signalToken) return;

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
                let actionCode = "";
                if (react.action) {
                    const isParameterless = react.action.endsWith('()');
                    const rawAction = react.action.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                    const actionWrapper = actionCatalog.get(rawAction)?.pascalName || rawAction;

                    if (isParameterless) {
                        actionCode = `                    Fa::Action<${actionWrapper}>::execute(m);\n`;
                    } else {
                        actionCode = `                    Fa::Action<${actionWrapper}>::execute(m, std::get<${signalToken}>(e));\n`;
                    }
                }

                if (react.guard) {
                    const isParameterless = react.guard.endsWith('()');
                    const cleanGuard = react.guard.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;

                    const guardEvalCall = isParameterless 
                        ? `Fa::Guard<${guardWrapper}>::eval(m)` 
                        : `Fa::Guard<${guardWrapper}>::eval(m, std::get<${signalToken}>(e))`;

                    out += `                ${isFirstBranch ? "if" : "else if"} (${guardEvalCall}) {\n`;
                    if (actionCode) out += actionCode;
                    
                    if (react.isExternal) {
                        const targetObj = states.find((tgt: any) => tgt.id === react.target);
                        out += `                    status = TransitionTo<${targetObj ? targetObj.name : "Fa::None"}>(m);\n`;
                    } else {
                        out += `                    status = Fa::Status::Handled;\n`;
                    }
                    out += `                }\n`;
                    isFirstBranch = false;
                } else {
                    holdsCatchallFallback = true;
                    if (isFirstBranch) {
                        if (actionCode) out += actionCode;
                        if (react.isExternal) {
                            const targetObj = states.find((tgt: any) => tgt.id === react.target);
                            out += `                status = TransitionTo<${targetObj ? targetObj.name : "Fa::None"}>(m);\n`;
                        } else {
                            out += `                status = Fa::Status::Handled;\n`;
                        }
                    } else {
                        out += `                else {\n`;
                        if (actionCode) out += "    " + actionCode;
                        if (react.isExternal) {
                            const targetObj = states.find((tgt: any) => tgt.id === react.target);
                            out += `                    status = TransitionTo<${targetObj ? targetObj.name : "Fa::None"}>(m);\n`;
                        } else {
                            out += `                    status = Fa::Status::Handled;\n`;
                        }
                        out += `                }\n`;
                    }
                }
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

    out += `// --- 7. Reflection Descriptor Specializations ---\n`;
    out += `namespace Fa {\n`;
    
    // States
    states.forEach((s: any) => {
        if (s.name) {
            out += `    template <> struct StateDescriptor<${machineName}::${s.name}> { static constexpr const char* name = "${s.name}"; };\n`;
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

    out += `// --- 8. Compile-Time State Machine Traits Configuration ---\n`;
    out += `#ifndef FA_SIM\n\n`;

    out += `// Embedded Target Hardware Traits Configuration\n`;
    out += `namespace ${machineName} {\n`;
    out += `    class Actor;\n`;
    out += `} // namespace ${machineName}\n\n`;

    out += `namespace Fa {\n`;
    out += `    template <>\n`;
    out += `    struct HsmTraits<${machineName}::Actor> {\n`;
    out += `        using StateCatalog = ${machineName}::StateCatalog;\n`;
    out += `        static constexpr auto InitialState = &${machineName}::ROOT::template Dispatch<${machineName}::Actor>;\n`;
    out += `        static constexpr uint16_t InitialStateId = type_id_v<${machineName}::ROOT, StateCatalog>;\n`;
    out += `    };\n`;
    out += `} // namespace Fa\n\n`;

    out += `#else\n\n`;

    out += `// Host Simulation Sandbox Traits Configuration\n`;
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
    out += `        static constexpr auto InitialState = &${machineName}::ROOT::template Dispatch<${machineName}::SimMachine>;\n`;
    out += `        static constexpr uint16_t InitialStateId = type_id_v<${machineName}::ROOT, StateCatalog>;\n`;
    out += `    };\n`;
    out += `} // namespace Fa\n\n`;

    out += `#endif // FA_SIM\n\n`;

    out += `#endif // ${upperMachineName}_HSM_HPP\n`;
    return out;
}

function generateCppConcreteHeaderStub(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();

    const { guardCatalog, actionCatalog } = extractCatalogs(hsm, machineName);

    let out = `// ==========================================================================\n`;
    out += `// CONCRETE ACTIVE OBJECT IMPLEMENTATION HEADER\n`;
    out += `// Machine: ${machineName}\n`;
    out += `// ==========================================================================\n\n`;

    out += `#pragma once\n`;
    out += `#ifndef ${upperMachineName}_ACTOR_HPP\n`;
    out += `#define ${upperMachineName}_ACTOR_HPP\n\n`;

    out += `#include "${machineName.toLowerCase()}_hsm.hpp"\n`;
    out += `#include "fa_actor.hpp"\n\n`;

    out += `namespace ${machineName} {\n\n`;
    out += `class Actor : public Fa::ActiveObject<Actor, Event> {\n`;
    out += `public:\n`;
    out += `    Actor();\n`;
    out += `    ~Actor() = default;\n\n`;

    out += `    // --- Guard Predicates ---\n`;
    if (guardCatalog.size === 0) {
        out += `    // No guard conditions registered.\n`;
    } else {
        guardCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `    bool ${item.rawMethod}() const;\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `    bool ${item.rawMethod}(${sig} const &e) const;\n`;
            });
        });
    }
    out += `\n`;

    out += `    // --- Action Handlers ---\n`;
    if (actionCatalog.size === 0) {
        out += `    // No action routines registered.\n`;
    } else {
        actionCatalog.forEach(item => {
            if (item.hasVoid || item.payloadEvents.size === 0) {
                out += `    void ${item.rawMethod}();\n`;
            }
            item.payloadEvents.forEach(sig => {
                out += `    void ${item.rawMethod}(${sig} const &e);\n`;
            });
        });
    }
    out += `\n`;

    out += `private:\n`;
    out += `    // User private fields & hardware peripheral handles\n`;
    out += `};\n\n`;

    out += `} // namespace ${machineName}\n\n`;
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
    out += `    : Fa::ActiveObject<Actor, Event>() {\n`;
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

function generateCppCliSimulatorString(jsonText: string): string {
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

function generateCMakeListsString(jsonText: string): string {
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
    out += `endif()\n`;

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
                    const blueprintFilename = `${lowerHsmName}_hsm.hpp`;
                    const actorHeaderFilename = `${lowerHsmName}_actor.hpp`;
                    const actorSourceFilename = `${lowerHsmName}_actor.cpp`;
                    const mainFilename = `main.cpp`;
                    const cmakeFilename = `CMakeLists.txt`;

                    const folderUri = vscode.Uri.joinPath(document.uri, '..');
                    const blueprintUri = vscode.Uri.joinPath(folderUri, blueprintFilename);
                    const actorHeaderUri = vscode.Uri.joinPath(folderUri, actorHeaderFilename);
                    const actorSourceUri = vscode.Uri.joinPath(folderUri, actorSourceFilename);
                    const mainUri = vscode.Uri.joinPath(folderUri, mainFilename);
                    const cmakeUri = vscode.Uri.joinPath(folderUri, cmakeFilename);

                    try {
                        const cppBlueprint = generateCppBlueprintString(jsonText);
                        const cppActorHeader = generateCppConcreteHeaderStub(jsonText);

                        await vscode.workspace.fs.writeFile(blueprintUri, stringToUint8Array(cppBlueprint));
                        await vscode.workspace.fs.writeFile(actorHeaderUri, stringToUint8Array(cppActorHeader));

                        let sourceExists = false, mainExists = false, cmakeExists = false;
                        try { await vscode.workspace.fs.stat(actorSourceUri); sourceExists = true; } catch {}
                        try { await vscode.workspace.fs.stat(mainUri); mainExists = true; } catch {}
                        try { await vscode.workspace.fs.stat(cmakeUri); cmakeExists = true; } catch {}

                        if (!sourceExists) {
                            await vscode.workspace.fs.writeFile(actorSourceUri, stringToUint8Array(generateCppConcreteSourceStub(jsonText)));
                        }
                        if (!mainExists) {
                            await vscode.workspace.fs.writeFile(mainUri, stringToUint8Array(generateCppCliSimulatorString(jsonText)));
                        }
                        if (!cmakeExists) {
                            await vscode.workspace.fs.writeFile(cmakeUri, stringToUint8Array(generateCMakeListsString(jsonText)));
                        }

                        await copyFrameworkFilesToWorkspace(this.context, folderUri);

                        if (!sourceExists || !mainExists || !cmakeExists) {
                            vscode.window.showInformationMessage(`🚀 Export complete! Generated '${blueprintFilename}', '${actorHeaderFilename}', and initial skeleton workspace.`);
                        } else {
                            vscode.window.showInformationMessage(`🔄 Updated contract headers '${blueprintFilename}' and '${actorHeaderFilename}'. Your '${actorSourceFilename}' was preserved!`);
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