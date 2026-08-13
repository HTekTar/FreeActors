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
    const sourceDirUri = vscode.Uri.joinPath(context.extensionUri, 'out', 'freeactors_lib');
    const frameworkFiles = ['fa_core.hpp', 'fa_mempool.hpp', 'fa_timeEvent.hpp', 'fa_util.hpp', 'fa_ops.hpp', 'fa_trace.hpp'];

    try {
        await vscode.workspace.fs.createDirectory(destinationDirUri);
        for (const filename of frameworkFiles) {
            const srcFileUri = vscode.Uri.joinPath(sourceDirUri, filename);
            const destFileUri = vscode.Uri.joinPath(destinationDirUri, filename);
            const fileData = await vscode.workspace.fs.readFile(srcFileUri);
            await vscode.workspace.fs.writeFile(destFileUri, fileData);
        }
        vscode.window.showInformationMessage('📦 FreeActors core framework files synchronized successfully!');
    } catch (error: any) {
        vscode.window.showErrorMessage(
            `❌ Framework Sync Failed.\n` +
            `Source Checked: ${sourceDirUri.fsPath}\n` +
            `Target Destination: ${destinationDirUri.fsPath}\n` +
            `Reason: ${error.message}`
        );
    }
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(FreeActorsEditorProvider.register(context));
}

function generateCppBlueprintString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [], initial_state: "" };
    try { hsm = JSON.parse(jsonText); } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();
    const concreteMachineName = "MyConcrete" + machineName;

    const rawSignals = (hsm.signals || []) as string[];
    const normalizedSignals = rawSignals.map(s => s.trim()).filter(s => s.length > 0);
    const states = (hsm.states || []) as any[];

    const toPascalCase = (str: string): string => {
        const clean = str.replace(/[^a-zA-Z0-9_]/g, "");
        if (!clean) return "Unnamed";
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    };

    const guardCatalog = new Map<string, { pascalName: string; rawMethod: string }>();
    const actionCatalog = new Map<string, { pascalName: string; rawMethod: string }>();

    ((hsm.guards || []) as string[]).forEach(g => {
        const trimmed = g.trim();
        if (trimmed) {
            const raw = trimmed.replace(/[^a-zA-Z0-9_]/g, "");
            guardCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
        }
    });

    ((hsm.actions || []) as string[]).forEach(a => {
        const trimmed = a.trim();
        if (trimmed) {
            const raw = trimmed.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
            actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
        }
    });

    states.forEach((s: any) => {
        if (s.entry) {
            const raw = s.entry.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
        }
        if (s.exit) {
            const raw = s.exit.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
        }

        if (s.transitions && Array.isArray(s.transitions)) {
            s.transitions.forEach((t: any) => {
                if (t.guard) {
                    const raw = t.guard.trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) guardCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
                }
                if (t.event && t.event.includes('/')) {
                    const actionPart = t.event.split('/')[1] || "";
                    const raw = actionPart.replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
                }
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const cleanEv = rawEv.replace('·', '').trim();
                if (cleanEv.includes('/')) {
                    const actionPart = cleanEv.split('/')[1] || "";
                    const raw = actionPart.replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
                }
            });
        }
    });

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

    out += `    // --- 1. Event Payloads (Forward Declarations) ---\n`;
    normalizedSignals.forEach(sig => {
        out += `    struct ${sig};\n`;
    });
    out += `\n`;

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

    out += `    // --- 2. Traceable Predicate Wrappers ---\n`;
    let elementIdCounter = 1;

    const guardPascalNames: string[] = [];
    const actionPascalNames: string[] = [];

    if (guardCatalog.size === 0) {
        out += `    // No conditional guards detected.\n`;
    } else {
        guardCatalog.forEach(({ pascalName, rawMethod }) => {
            const currentId = elementIdCounter++;
            guardPascalNames.push(pascalName);
            out += `    struct ${pascalName} {\n`;
            out += `        static constexpr const char* name = "${pascalName}";\n`;
            out += `        static constexpr uint16_t id = ${currentId};\n\n`;
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
            actionPascalNames.push(pascalName);
            out += `    struct ${pascalName} {\n`;
            out += `        static constexpr const char* name = "${pascalName}";\n`;
            out += `        static constexpr uint16_t id = ${currentId};\n\n`;
            out += `        template <typename M>\n`;
            out += `        static void execute(M &m) { m.${rawMethod}(); }\n\n`;
            out += `        template <typename M, typename E>\n`;
            out += `        static void execute(M &m, E const &e) { m.${rawMethod}(e); }\n`;
            out += `    };\n\n`;
        });
    }

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

    out += `    // --- 5. Structural Inheritance Tree ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;
        
        let parentClassName = "None";
        if (s.parent) {
            const parentObj = states.find((p: any) => p.id === s.parent);
            if (parentObj && parentObj.name) {
                parentClassName = parentObj.name;
            }
        }
        
        out += `    struct ${s.name} : public StateInterface<${s.name}, Event, ${parentClassName}> {\n`;
        out += `        template <typename M> static Status handle(M &m, Event const &e);\n`;
        out += `    };\n\n`;
    });

    out += `    // --- 6. State Handler Implementations ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;

        out += `    template <typename M>\n`;
        out += `    Status ${s.name}::handle(M &m, Event const &e) {\n`;
        out += `        Fa::Status status;\n`;
        out += `        switch(e.index()) {\n`;

        out += `            case get_index_v<Fa::Enter_sig, Event>:\n`;
        if (s.entry) {
            const raw = s.entry.replace(/[^a-zA-Z0-9_]/g, "");
            const entryWrapper = actionCatalog.get(raw)?.pascalName;
            if (entryWrapper) {
                out += `                Fa::Action<${entryWrapper}>::execute(m);\n`;
            }
        }
        out += `                status = Fa::Status::Handled;\n`;
        out += `                break;\n`;

        out += `            case get_index_v<Fa::Exit_sig, Event>:\n`;
        if (s.exit) {
            const raw = s.exit.replace(/[^a-zA-Z0-9_]/g, "");
            const exitWrapper = actionCatalog.get(raw)?.pascalName;
            if (exitWrapper) {
                out += `                Fa::Action<${exitWrapper}>::execute(m);\n`;
            }
        }
        out += `                status = Fa::Status::Handled;\n`;
        out += `                break;\n`;

        const allTransitions = (s.transitions || []) as any[];
        const initTransitions = allTransitions.filter((t: any) => t.event === 'Init_sig');
        
        if (initTransitions.length > 0) {
            out += `            case get_index_v<Fa::Init_sig, Event>:\n`;
            const sortedInit = [...initTransitions].sort((a: any, b: any) => (a.guard && !b.guard) ? -1 : (!a.guard && b.guard) ? 1 : 0);
            let isFirst = true;
            sortedInit.forEach((t: any) => {
                const targetStateObj = states.find((tgt: any) => tgt.id === t.target);
                if (!targetStateObj || !targetStateObj.name) return;

                if (t.guard) {
                    const cleanGuard = t.guard.replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;
                    out += `                ${isFirst ? "if" : "else if"} (Fa::Guard<${guardWrapper}>::eval(m)) {\n`;
                    out += `                    status = Fa::Transition<${s.name}, ${targetStateObj.name}>::template execute<M, Event>(m);\n`;
                    out += `                }\n`;
                    isFirst = false;
                } else {
                    out += `                ${isFirst ? "" : "else "}{\n`;
                    out += `                    status = Fa::Transition<${s.name}, ${targetStateObj.name}>::template execute<M, Event>(m);\n`;
                    out += `                }\n`;
                }
            });
            out += `                break;\n`;
        }

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
            out += `            case get_index_v<${signalToken}, Event>:\n`;

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
                    const cleanGuard = react.guard.replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;

                    out += `                ${isFirstBranch ? "if" : "else if"} (Fa::Guard<${guardWrapper}>::eval(m, e)) {\n`;
                    if (actionCode) out += actionCode;
                    
                    if (react.isExternal) {
                        const targetObj = states.find((tgt: any) => tgt.id === react.target);
                        out += `                    status = Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, Event>(m);\n`;
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
                            out += `                status = Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, Event>(m);\n`;
                        } else {
                            out += `                status = Fa::Status::Handled;\n`;
                        }
                    } else {
                        out += `                else {\n`;
                        if (actionCode) out += "    " + actionCode;
                        if (react.isExternal) {
                            const targetObj = states.find((tgt: any) => tgt.id === react.target);
                            out += `                    status = Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, Event>(m);\n`;
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

    out += `// --- 7. Compile-Time State Machine Traits Configuration ---\n`;
    
    let initialSelectedStateName = "ROOT";
    const rootState = states.find((s: any) => !s.parent);
    if (rootState && rootState.transitions) {
        const bootTransition = rootState.transitions.find((t: any) => t.event === 'Init_sig' && !t.guard);
        if (bootTransition) {
            const matchingState = states.find((s: any) => s.id === bootTransition.target);
            if (matchingState && matchingState.name) {
                initialSelectedStateName = matchingState.name;
            }
        }
    }

    out += `template <>\n`;
    out += `struct HsmTraits<${machineName}::${concreteMachineName}> {\n`;
    out += `    static constexpr auto InitialState = &${machineName}::${initialSelectedStateName}::template Dispatch<${machineName}::${concreteMachineName}>;\n`;
    out += `};\n\n`;

    out += `#endif // ${upperMachineName}_HSM_HPP\n`;
    return out;
}

function generateCppConcreteHeaderStub(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {
        return "// Error: Invalid HSM structure. Cannot generate C++ concrete header stub.";
    }

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();
    const upperMachineName = machineName.toUpperCase();
    const concreteName = "MyConcrete" + machineName;

    const states = (hsm.states || []) as any[];
    const collectedGuards = new Set<string>();
    const uniqueSignatures = new Set<string>();

    ((hsm.guards || []) as string[]).forEach(g => {
        const trimmed = g.trim().replace(/[^a-zA-Z0-9_]/g, "");
        if (trimmed) collectedGuards.add(trimmed);
    });

    states.forEach((s: any) => {
        if (s.entry) {
            const raw = s.entry.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) uniqueSignatures.add(`${raw}()`);
        }
        if (s.exit) {
            const raw = s.exit.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) uniqueSignatures.add(`${raw}()`);
        }

        const processActionToken = (actionToken: string, signalToken: string) => {
            if (!actionToken || !signalToken) return;
            const cleanAction = actionToken.replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
            const cleanSignal = signalToken.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (!cleanAction) return;

            if (actionToken.endsWith('()')) {
                uniqueSignatures.add(`${cleanAction}()`);
            } else {
                uniqueSignatures.add(`${cleanAction}(${cleanSignal})`);
            }
        };

        if (s.transitions && Array.isArray(s.transitions)) {
            s.transitions.forEach((t: any) => {
                if (t.guard) {
                    const raw = t.guard.trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) collectedGuards.add(raw);
                }
                if (t.event && t.event.includes('/')) {
                    const parts = t.event.split('/');
                    processActionToken((parts[1] || "").trim(), (parts[0] || "").trim());
                }
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const cleanEv = rawEv.replace('·', '').trim();
                if (cleanEv.includes('/')) {
                    const parts = cleanEv.split('/');
                    processActionToken((parts[1] || "").trim(), (parts[0] || "").trim());
                }
            });
        }
    });

    const uniqueGuards = Array.from(collectedGuards);
    const signatureList = Array.from(uniqueSignatures);

    let out = `// ==========================================================================\n`;
    out += `// C++ CONCRETE ACTIVE OBJECT IMPLEMENTATION HEADER\n`;
    out += `// ==========================================================================\n\n`;
    
    out += `#ifndef ${upperMachineName}_IMPL_HPP\n`;
    out += `#define ${upperMachineName}_IMPL_HPP\n\n`;
    out += `#include "${lowerMachineName}_hsm.hpp"\n\n`;
    
    out += `namespace ${machineName} {\n\n`;
    out += `    struct ${concreteName} : public Hsm<${concreteName}, Event> {\n`;
    out += `        explicit ${concreteName}();\n\n`;

    out += `        // --- Active Guard Target Condition Checks ---\n`;
    if (uniqueGuards.length === 0) {
        out += `        // No conditional guards found in graphical layout.\n`;
    } else {
        uniqueGuards.forEach(guard => {
            out += `        bool ${guard}() const;\n`;
        });
    }
    out += `\n`;

    out += `        // --- Graphical Behavioral Hook Subroutines ---\n`;
    if (signatureList.length === 0) {
        out += `        // No structural exit/entry/internal/transition hooks found.\n`;
    } else {
        signatureList.forEach(sig => {
            if (sig.endsWith('()')) {
                const cleanAction = sig.replace('()', '');
                out += `        void ${cleanAction}();\n`;
            } else {
                const openParenIdx = sig.indexOf('(');
                const closeParenIdx = sig.indexOf(')');
                const cleanAction = sig.substring(0, openParenIdx);
                const signalParam = sig.substring(openParenIdx + 1, closeParenIdx);
                out += `        void ${cleanAction}(${signalParam} const &e);\n`;
            }
        });
    }

    out += `    };\n\n`;
    out += `} // namespace ${machineName}\n\n`;
    out += `#endif // ${upperMachineName}_IMPL_HPP\n`;
    return out;
}

function generateCppConcreteSourceStub(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {
        return "// Error: Invalid HSM structure. Cannot generate C++ concrete source stub.";
    }

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();
    const concreteName = "MyConcrete" + machineName;

    const states = (hsm.states || []) as any[];
    const collectedGuards = new Set<string>();
    const uniqueSignatures = new Set<string>();

    ((hsm.guards || []) as string[]).forEach(g => {
        const trimmed = g.trim().replace(/[^a-zA-Z0-9_]/g, "");
        if (trimmed) collectedGuards.add(trimmed);
    });

    states.forEach((s: any) => {
        if (s.entry) {
            const raw = s.entry.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) uniqueSignatures.add(`${raw}()`);
        }
        if (s.exit) {
            const raw = s.exit.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (raw) uniqueSignatures.add(`${raw}()`);
        }

        const processActionToken = (actionToken: string, signalToken: string) => {
            if (!actionToken || !signalToken) return;
            const cleanAction = actionToken.replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
            const cleanSignal = signalToken.trim().replace(/[^a-zA-Z0-9_]/g, "");
            if (!cleanAction) return;

            if (actionToken.endsWith('()')) {
                uniqueSignatures.add(`${cleanAction}()`);
            } else {
                uniqueSignatures.add(`${cleanAction}(${cleanSignal})`);
            }
        };

        if (s.transitions && Array.isArray(s.transitions)) {
            s.transitions.forEach((t: any) => {
                if (t.guard) {
                    const raw = t.guard.trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) collectedGuards.add(raw);
                }
                if (t.event && t.event.includes('/')) {
                    const parts = t.event.split('/');
                    processActionToken((parts[1] || "").trim(), (parts[0] || "").trim());
                }
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const cleanEv = rawEv.replace('·', '').trim();
                if (cleanEv.includes('/')) {
                    const parts = cleanEv.split('/');
                    processActionToken((parts[1] || "").trim(), (parts[0] || "").trim());
                }
            });
        }
    });

    const uniqueGuards = Array.from(collectedGuards);
    const signatureList = Array.from(uniqueSignatures);

    let out = `// ==========================================================================\n`;
    out += `// C++ CONCRETE ACTIVE OBJECT IMPLEMENTATION SOURCE\n`;
    out += `// ==========================================================================\n\n`;
    
    out += `#include "${lowerMachineName}_impl.hpp"\n`;
    out += `#include <iostream>\n\n`;

    out += `namespace ${machineName} {\n\n`;

    out += `    ${concreteName}::${concreteName}() : Hsm() {\n`;
    out += `        // Initialize active object timers or state data fields here\n`;
    out += `    }\n\n`;

    out += `    // --- Active Guard Target Condition Checks ---\n`;
    uniqueGuards.forEach(guard => {
        out += `    bool ${concreteName}::${guard}() const {\n`;
        out += `        return true;\n`;
        out += `    }\n\n`;
    });

    out += `    // --- Graphical Behavioral Hook Subroutines ---\n`;
    signatureList.forEach(sig => {
        if (sig.endsWith('()')) {
            const cleanAction = sig.replace('()', '');
            out += `    void ${concreteName}::${cleanAction}() {\n`;
            out += `        std::cout << "Action Routine [${cleanAction}] executed\\n";\n`;
            out += `    }\n\n`;
        } else {
            const openParenIdx = sig.indexOf('(');
            const closeParenIdx = sig.indexOf(')');
            const cleanAction = sig.substring(0, openParenIdx);
            const signalParam = sig.substring(openParenIdx + 1, closeParenIdx);
            
            out += `    void ${concreteName}::${cleanAction}(${signalParam} const &e) {\n`;
            out += `        (void)e; // Suppress unused parameter warning\n`;
            out += `        std::cout << "Action Routine [${cleanAction}] executed for signal payload\\n";\n`;
            out += `    }\n\n`;
        }
    });

    out += `} // namespace ${machineName}\n`;
    return out;
}

function generateCppCliSimulatorString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {
        return "// Error: Invalid HSM structure. Cannot generate CLI Simulator.";
    }

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();
    const concreteName = "MyConcrete" + machineName;

    const rawSignals = (hsm.signals || []) as string[];
    const normalizedSignals = rawSignals.map(s => s.trim()).filter(s => s.length > 0);

    let out = `// ==========================================================================\n`;
    out += `// FREEACTORS CLI SANDBOX SIMULATOR - AUTO-GENERATED\n`;
    out += `// ==========================================================================\n\n`;

    out += `#define FA_SIM\n`;
    out += `#include "${lowerMachineName}_impl.hpp"\n`;
    out += `#include <iostream>\n`;
    out += `#include <string>\n\n`;

    out += `int main() {\n`;
    out += `    std::cout << "\\033[1;36m============================================================\\033[0m\\n";\n`;
    out += `    std::cout << "\\033[1;32m   📦 FREEACTORS CLI SANDBOX SIMULATOR: ${machineName}\\033[0m\\n";\n`;
    out += `    std::cout << "\\033[1;36m============================================================\\033[0m\\n\\n";\n\n`;

    out += `    ${machineName}::${concreteName} actor;\n`;
    out += `    actor.start(); // Triggers initial transition\n\n`;

    out += `    std::cout << "\\033[1;33mAvailable Signals:\\033[0m ";\n`;
    if (normalizedSignals.length === 0) {
        out += `    std::cout << "(None registered)\\n";\n`;
    } else {
        out += `    std::cout << "${normalizedSignals.join(', ')}\\n";\n`;
    }
    out += `    std::cout << "Type \\033[1;31mquit\\033[0m or \\033[1;31mexit\\033[0m to terminate the simulation.\\n\\n";\n\n`;

    out += `    std::string input;\n`;
    out += `    while (true) {\n`;
    out += `        std::cout << "\\033[1;35mEnter Signal > \\033[0m";\n`;
    out += `        if (!(std::cin >> input)) break;\n`;
    out += `        if (input == "quit" || input == "exit") break;\n\n`;

    let isFirst = true;
    normalizedSignals.forEach(sig => {
        out += `        ${isFirst ? "if" : "else if"} (input == "${sig}") {\n`;
        out += `            actor.dispatch(${machineName}::${sig}{});\n`;
        out += `        }\n`;
        isFirst = false;
    });

    if (!isFirst) {
        out += `        else {\n`;
        out += `            std::cout << "  \\033[1;31m[ERROR]\\033[0m Unknown signal identity: '" << input << "'\\n";\n`;
        out += `        }\n`;
    }

    out += `    }\n\n`;
    out += `    std::cout << "\\n\\033[1;30m[SYSTEM] Simulation terminated.\\033[0m\\n";\n`;
    out += `    return 0;\n`;
    out += `}\n`;

    return out;
}

function generateCMakeListsString(jsonText: string): string {
    let hsm = { name: "ActorMachine" };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {}

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();

    let out = `cmake_minimum_required(VERSION 3.10)\n`;
    out += `project(${lowerMachineName}_sim CXX)\n\n`;

    out += `set(CMAKE_CXX_STANDARD 17)\n`;
    out += `set(CMAKE_CXX_STANDARD_REQUIRED ON)\n\n`;

    out += `# Include local FreeActors framework headers\n`;
    out += `include_directories(./freeactors)\n\n`;

    out += `# Build Desktop CLI Simulation Executable\n`;
    out += `add_executable(${lowerMachineName}_sim\n`;
    out += `    main.cpp\n`;
    out += `    ${lowerMachineName}_impl.cpp\n`;
    out += `)\n`;

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
            const rootStateName = sanitizedName.toUpperCase() + "_ROOT";
            
            const defaultSkeleton = {
                name: sanitizedName,
                signals: [],
                guards: [],
                actions: [],
                states: [
                    {
                        id: "STATE_ROOT",
                        name: rootStateName,
                        x: 50,
                        y: 50,
                        width: 700,
                        height: 500,
                        entry: "entry_" + rootStateName,
                        exit: "exit_" + rootStateName
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
                    const implHeaderFilename = `${lowerHsmName}_impl.hpp`;
                    const implSourceFilename = `${lowerHsmName}_impl.cpp`;
                    const mainFilename = `main.cpp`;
                    const cmakeFilename = `CMakeLists.txt`;

                    const folderUri = vscode.Uri.joinPath(document.uri, '..');
                    const blueprintUri = vscode.Uri.joinPath(folderUri, blueprintFilename);
                    const implHeaderUri = vscode.Uri.joinPath(folderUri, implHeaderFilename);
                    const implSourceUri = vscode.Uri.joinPath(folderUri, implSourceFilename);
                    const mainUri = vscode.Uri.joinPath(folderUri, mainFilename);
                    const cmakeUri = vscode.Uri.joinPath(folderUri, cmakeFilename);

                    try {
                        const cppBlueprint = generateCppBlueprintString(jsonText);
                        const cppImplHeader = generateCppConcreteHeaderStub(jsonText);

                        await vscode.workspace.fs.writeFile(blueprintUri, stringToUint8Array(cppBlueprint));
                        await vscode.workspace.fs.writeFile(implHeaderUri, stringToUint8Array(cppImplHeader));

                        let sourceExists = false, mainExists = false, cmakeExists = false;
                        try { await vscode.workspace.fs.stat(implSourceUri); sourceExists = true; } catch {}
                        try { await vscode.workspace.fs.stat(mainUri); mainExists = true; } catch {}
                        try { await vscode.workspace.fs.stat(cmakeUri); cmakeExists = true; } catch {}

                        if (!sourceExists) {
                            await vscode.workspace.fs.writeFile(implSourceUri, stringToUint8Array(generateCppConcreteSourceStub(jsonText)));
                        }
                        if (!mainExists) {
                            await vscode.workspace.fs.writeFile(mainUri, stringToUint8Array(generateCppCliSimulatorString(jsonText)));
                        }
                        if (!cmakeExists) {
                            await vscode.workspace.fs.writeFile(cmakeUri, stringToUint8Array(generateCMakeListsString(jsonText)));
                        }

                        await copyFrameworkFilesToWorkspace(this.context, folderUri);

                        if (!sourceExists || !mainExists || !cmakeExists) {
                            vscode.window.showInformationMessage(`🚀 Export complete! Generated '${blueprintFilename}', '${implHeaderFilename}', and initial skeleton workspace.`);
                        } else {
                            vscode.window.showInformationMessage(`🔄 Updated contract headers '${blueprintFilename}' and '${implHeaderFilename}'. Your '${implSourceFilename}' was preserved!`);
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