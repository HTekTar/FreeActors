import * as vscode from 'vscode';

function stringToUint8Array(str: string): Uint8Array {
    const arr = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        arr[i] = str.charCodeAt(i) & 0xFF;
    }
    return arr;
}

export async function copyFrameworkFilesToWorkspace(context: vscode.ExtensionContext, folderUri: vscode.Uri) {
    // 1. Point to the 'freeactors' subfolder directly inside the active HSM file's directory path
    const destinationDirUri = vscode.Uri.joinPath(folderUri, 'freeactors');

    // 2. Point to the folder inside the compiled extension bundle execution runtime path
    const sourceDirUri = vscode.Uri.joinPath(context.extensionUri, 'out', 'freeactors_lib');

    // Define the core engine framework header asset portfolio files to copy over
    const frameworkFiles = ['fa_core.hpp', 'fa_mempool.hpp', 'fa_timeEvent.hpp', 'fa_util.hpp'];

    try {
        // Create the destination project directory safely (safe if already exists)
        await vscode.workspace.fs.createDirectory(destinationDirUri);

        // 3. Read and copy each file directly from the extension bundle pack
        for (const filename of frameworkFiles) {
            const srcFileUri = vscode.Uri.joinPath(sourceDirUri, filename);
            const destFileUri = vscode.Uri.joinPath(destinationDirUri, filename);

            // Read the binary stream buffer out of the extension install track
            const fileData = await vscode.workspace.fs.readFile(srcFileUri);
            
            // Write the buffer straight to the user's project folder workspace space
            await vscode.workspace.fs.writeFile(destFileUri, fileData);
        }

        vscode.window.showInformationMessage('📦 FreeActors core framework files synchronized successfully next to your blueprints!');
    } catch (error: any) {
        // Updated to print out the absolute absolute string evaluation vectors for diagnostic review
        vscode.window.showErrorMessage(
            `❌ Framework Sync Failed.\n` +
            `Source Checked: \${sourceDirUri.fsPath}\n` +
            `Target Destination: \${destinationDirUri.fsPath}\n` +
            `Reason: \${error.message}`
        );
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Register our custom editor provider, forwarding the extension runtime context handle along
    context.subscriptions.push(FreeActorsEditorProvider.register(context));
}

function generateCppBlueprintString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [], initial_state: "" };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {
        return "// Error: Invalid HSM JSON structure. Cannot generate C++ code.";
    }

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const upperMachineName = machineName.toUpperCase();
    const concreteMachineName = "MyConcrete" + machineName;
    
    const rawSignals = (hsm.signals || []) as string[];
    const normalizedSignals = rawSignals.map(s => s.trim()).filter(s => s.length > 0);
    const states = (hsm.states || []) as any[];

    // Helper to format string tokens to PascalCase for C++ Struct Names
    const toPascalCase = (str: string): string => {
        const clean = str.replace(/[^a-zA-Z0-9_]/g, "");
        if (!clean) return "Unnamed";
        return clean.charAt(0).toUpperCase() + clean.slice(1);
    };

    // --- Scrape & Catalog Unique Guards and Actions for Predicate Structs ---
    const guardCatalog = new Map<string, { pascalName: string; rawMethod: string }>();
    const actionCatalog = new Map<string, { pascalName: string; rawMethod: string }>();

    // 1. Scrape Guards
    ((hsm.guards || []) as string[]).forEach(g => {
        const trimmed = g.trim();
        if (trimmed) {
            const raw = trimmed.replace(/[^a-zA-Z0-9_]/g, "");
            guardCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
        }
    });

    // 2. Scrape Actions & Entry/Exit Routines
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
                    const raw = t.event.split('/')[1].replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
                    if (raw) actionCatalog.set(raw, { pascalName: toPascalCase(raw), rawMethod: raw });
                }
            });
        }

        if (s.local_events && Array.isArray(s.local_events)) {
            s.local_events.forEach((rawEv: string) => {
                if (typeof rawEv !== 'string') return;
                const cleanEv = rawEv.replace('·', '').trim();
                if (cleanEv.includes('/')) {
                    const rawActionToken = cleanEv.split('/')[1] || "";
                    const raw = rawActionToken.replace('()', '').trim().replace(/[^a-zA-Z0-9_]/g, "");
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
    out += `#include <iostream>\n\n`;

    // --- TOP-LEVEL MACHINE NAMESPACE ---
    out += `namespace ${machineName} {\n\n`;

    // --- 1. Signals & Event Variant ---
    out += `    // --- 1. Event Payloads (Forward Declarations) ---\n`;
    normalizedSignals.forEach(sig => {
        out += `    struct ${sig};\n`;
    });
    out += `\n`;

    out += `    using AppEvents = std::variant<\n`;
    out += `        Enter_sig,\n`;
    out += `        Exit_sig,\n`;
    out += `        Init_sig,\n`;
    out += `        ExitToParent_sig`;
    normalizedSignals.forEach(sig => {
        out += `,\n        ${sig}`;
    });
    out += `\n    >;\n\n`;

    // --- 2. Predicate Struct Wrappers (Guards & Actions) ---
    out += `    // --- 2. Traceable Predicate Wrappers ---\n`;
    let elementIdCounter = 1;

    if (guardCatalog.size === 0) {
        out += `    // No conditional guards detected.\n`;
    } else {
        guardCatalog.forEach(({ pascalName, rawMethod }) => {
            const currentId = elementIdCounter++;
            out += `    struct ${pascalName} {\n`;
            out += `        static constexpr const char* name = "${pascalName}";\n`;
            out += `        static constexpr uint16_t id = ${currentId};\n\n`;
            out += `        template <typename M>\n`;
            out += `        static bool eval(M const &m) { return m.${rawMethod}(); }\n\n`;
            out += `        template <typename M, typename E>\n`;
            out += `        static bool eval(M const &m, E const &e) { return m.${rawMethod}(e); }\n`;
            out += `    };\n\n`;
            guardCatalog.get(rawMethod)!.pascalName = pascalName; // Store for lookup inside handler
        });
    }

    if (actionCatalog.size === 0) {
        out += `    // No action routines detected.\n`;
    } else {
        actionCatalog.forEach(({ pascalName, rawMethod }) => {
            const currentId = elementIdCounter++;
            out += `    struct ${pascalName} {\n`;
            out += `        static constexpr const char* name = "${pascalName}";\n`;
            out += `        static constexpr uint16_t id = ${currentId};\n\n`;
            out += `        template <typename M>\n`;
            out += `        static void execute(M &m) { m.${rawMethod}(); }\n\n`;
            out += `        template <typename M, typename E>\n`;
            out += `        static void execute(M &m, E const &e) { m.${rawMethod}(e); }\n`;
            out += `    };\n\n`;
            actionCatalog.get(rawMethod)!.pascalName = pascalName; // Store for lookup inside handler
        });
    }

    // --- 3. Forward Declarations of States ---
    out += `    // --- 3. Forward Declarations of States ---\n`;
    states.forEach((s: any) => {
        if (s.name) {
            out += `    struct ${s.name};\n`;
        }
    });
    out += `\n`;

    // --- 4. Structural Tree Blueprint ---
    out += `    // --- 4. Structural Inheritance Tree ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;
        
        let parentClassName = "None";
        if (s.parent) {
            const parentObj = states.find((p: any) => p.id === s.parent);
            if (parentObj && parentObj.name) {
                parentClassName = parentObj.name;
            }
        }
        
        out += `    struct ${s.name} : public StateInterface<${s.name}, AppEvents, ${parentClassName}> {\n`;
        out += `        template <typename M> static Status handle(M &m, AppEvents const &e);\n`;
        out += `    };\n\n`;
    });

    // --- 5. Unified State Handler Implementations ---
    out += `    // --- 5. State Handler Implementations ---\n`;
    states.forEach((s: any) => {
        if (!s.name) return;

        out += `    template <typename M>\n`;
        out += `    Status ${s.name}::handle(M &m, AppEvents const &e) {\n`;
        out += `        switch(e.index()) {\n`;

        // Handle Entry Action Hook
        out += `            case get_index_v<Enter_sig, AppEvents>:\n`;
        if (s.entry) {
            const raw = s.entry.replace(/[^a-zA-Z0-9_]/g, "");
            const entryWrapper = actionCatalog.get(raw)?.pascalName;
            if (entryWrapper) {
                out += `                Fa::Action<${entryWrapper}>::execute(m);\n`;
            }
        }
        out += `                break;\n`;

        // Handle Exit Action Hook
        out += `            case get_index_v<Exit_sig, AppEvents>:\n`;
        if (s.exit) {
            const raw = s.exit.replace(/[^a-zA-Z0-9_]/g, "");
            const exitWrapper = actionCatalog.get(raw)?.pascalName;
            if (exitWrapper) {
                out += `                Fa::Action<${exitWrapper}>::execute(m);\n`;
            }
        }
        out += `                break;\n`;

        // Separate out Initialization transitions
        const allTransitions = (s.transitions || []) as any[];
        const initTransitions = allTransitions.filter((t: any) => t.event === 'Init_sig');
        
        if (initTransitions.length > 0) {
            out += `            case get_index_v<Init_sig, AppEvents>:\n`;
            const sortedInit = [...initTransitions].sort((a: any, b: any) => (a.guard && !b.guard) ? -1 : (!a.guard && b.guard) ? 1 : 0);
            let isFirst = true;
            sortedInit.forEach((t: any) => {
                const targetStateObj = states.find((tgt: any) => tgt.id === t.target);
                if (!targetStateObj || !targetStateObj.name) return;

                if (t.guard) {
                    const cleanGuard = t.guard.replace(/[^a-zA-Z0-9_]/g, "");
                    const guardWrapper = guardCatalog.get(cleanGuard)?.pascalName || cleanGuard;
                    out += `                ${isFirst ? "if" : "else if"} (Fa::Guard<${guardWrapper}>::eval(m)) {\n`;
                    out += `                    Fa::Transition<${s.name}, ${targetStateObj.name}>::template execute<M, AppEvents>(m);\n`;
                    out += `                    return Status::Handled;\n`;
                    out += `                }\n`;
                    isFirst = false;
                } else {
                    out += `                ${isFirst ? "" : "else "}{\n`;
                    out += `                    Fa::Transition<${s.name}, ${targetStateObj.name}>::template execute<M, AppEvents>(m);\n`;
                    out += `                    return Status::Handled;\n`;
                    out += `                }\n`;
                }
            });
            if (!sortedInit.some((t: any) => !t.guard)) {
                out += `                break;\n`;
            }
        }

        // =========================================================================
        // UNIFIED REACTION COMPILER PIPELINE
        // =========================================================================
        const reactionGroups: { [signal: string]: any[] } = {};

        // 1. Process regular graphical routing wire arrows
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

        // 2. Process card compartment text elements (local handled events)
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

        // Emit switch branches
        Object.keys(reactionGroups).forEach((signalToken) => {
            const list = reactionGroups[signalToken] || [];
            out += `            case get_index_v<${signalToken}, AppEvents>:\n`;

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
                        out += `                    Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, AppEvents>(m);\n`;
                        out += `                    return Status::Handled;\n`;
                    } else {
                        out += `                    return Status::Handled;\n`;
                    }
                    out += `                }\n`;
                    isFirstBranch = false;
                } else {
                    holdsCatchallFallback = true;
                    if (isFirstBranch) {
                        if (actionCode) out += actionCode;
                        if (react.isExternal) {
                            const targetObj = states.find((tgt: any) => tgt.id === react.target);
                            out += `                Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, AppEvents>(m);\n`;
                            out += `                return Status::Handled;\n`;
                        } else {
                            out += `                return Status::Handled;\n`;
                        }
                    } else {
                        out += `                else {\n`;
                        if (actionCode) out += "    " + actionCode;
                        if (react.isExternal) {
                            const targetObj = states.find((tgt: any) => tgt.id === react.target);
                            out += `                    Fa::Transition<${s.name}, ${targetObj ? targetObj.name : "None"}>::template execute<M, AppEvents>(m);\n`;
                            out += `                    return Status::Handled;\n`;
                        } else {
                            out += `                    return Status::Handled;\n`;
                        }
                        out += `                }\n`;
                    }
                }
            });

            if (!holdsCatchallFallback) {
                out += `                return Super(m, e);\n`;
            }
        });

        out += `            default:\n`;
        out += `                return Super(m, e);\n`;
        out += `        }\n`;
        out += `    }\n\n`;
    });

    // Close Machine Namespace
    out += `} // namespace ${machineName}\n\n`;

    // --- 6. Compile-Time State Machine Traits Configuration ---
    out += `// --- 6. Compile-Time State Machine Traits Configuration ---\n`;
    
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
    out += `struct HsmTraits<${concreteMachineName}> {\n`;
    out += `    static constexpr auto InitialState = &${machineName}::${initialSelectedStateName}::template Dispatch<${concreteMachineName}>;\n`;
    out += `};\n\n`;

    out += `#endif // ${upperMachineName}_HSM_HPP\n`;
    return out;
}

function generateCppConcreteStubString(jsonText: string): string {
    let hsm = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
    try {
        hsm = JSON.parse(jsonText);
    } catch (e) {
        return "// Error: Invalid HSM structure. Cannot generate C++ concrete stubs.";
    }

    const machineName = hsm.name ? hsm.name.replace(/[^a-zA-Z0-9_]/g, "") : "ActorMachine";
    const lowerMachineName = machineName.toLowerCase();
    const upperMachineName = machineName.toUpperCase();
    const concreteName = "MyConcrete" + machineName;

    const states = (hsm.states || []) as any[];
    const collectedGuards = new Set<string>();
    const uniqueSignatures = new Set<string>();

    ((hsm.guards || []) as string[]).forEach(g => collectedGuards.add(g.trim()));

    states.forEach((s: any) => {
        if (s.entry) uniqueSignatures.add(`${s.entry.trim()}()`);
        if (s.exit) uniqueSignatures.add(`${s.exit.trim()}()`);

        const processActionToken = (actionToken: string, signalToken: string) => {
            if (!actionToken || !signalToken) return;
            if (actionToken.endsWith('()')) {
                const baseAct = actionToken.replace('()', '').trim();
                if (baseAct) uniqueSignatures.add(`${baseAct}()`);
            } else {
                uniqueSignatures.add(`${actionToken}(${signalToken})`);
            }
        };

        // Scrape actions from Graphical Transitions
        if (s.transitions && Array.isArray(s.transitions)) {
            s.transitions.forEach((t: any) => {
                if (t.guard) collectedGuards.add(t.guard.trim());
                if (t.event && t.event.includes('/')) {
                    const parts = t.event.split('/');
                    processActionToken((parts[1] || "").trim(), (parts[0] || "").trim());
                }
            });
        }

        // Scrape actions from Internal Card Text Events
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

    const uniqueGuards = Array.from(collectedGuards).filter(g => g.length > 0);
    const signatureList = Array.from(uniqueSignatures);

    let out = `// ==========================================================================\n`;
    out += `// C++ CONCRETE ACTIVE OBJECT IMPLEMENTATION STUB\n`;
    out += `// ==========================================================================\n\n`;
    
    out += `#ifndef ${upperMachineName}_IMPL_HPP\n`;
    out += `#define ${upperMachineName}_IMPL_HPP\n\n`;
    out += `#include "${lowerMachineName}_hsm.hpp"\n`;
    out += `#include <iostream>\n\n`;
    
    out += `struct ${concreteName} : public Hsm<${concreteName}, AppEvents> {\n`;
    out += `    explicit ${concreteName}() : Hsm() {} \n\n`;

    out += `    // --- Active Guard Target Condition Checks ---\n`;
    if (uniqueGuards.length === 0) {
        out += `    // No conditional guards found in graphical layout.\n`;
    } else {
        uniqueGuards.forEach(guard => {
            out += `    bool ${guard.replace(/[^a-zA-Z0-9_]/g, "")}() const {\n`;
            out += `        return true;\n`;
            out += `    }\n\n`;
        });
    }

    out += `    // --- Graphical Behavioral Hook Subroutines ---\n`;
    if (signatureList.length === 0) {
        out += `    // No structural exit/entry/internal/transition hooks found.\n`;
    } else {
        signatureList.forEach(sig => {
            if (sig.endsWith('()')) {
                const cleanAction = sig.replace('()', '').replace(/[^a-zA-Z0-9_]/g, "");
                out += `    void ${cleanAction}() {\n`;
                out += `        std::cout << "Action Routine [${cleanAction}] executed (Parameterless)\\n";\n`;
                out += `    }\n\n`;
            } else {
                const openParenIdx = sig.indexOf('(');
                const closeParenIdx = sig.indexOf(')');
                const cleanAction = sig.substring(0, openParenIdx).replace(/[^a-zA-Z0-9_]/g, "");
                const signalParam = sig.substring(openParenIdx + 1, closeParenIdx).replace(/[^a-zA-Z0-9_]/g, "");
                
                out += `    void ${cleanAction}(${signalParam} const &e) {\n`;
                out += `        (void)e; // Suppresses compiler unused-parameter warning\n`;
                out += `        std::cout << "Action Routine [${cleanAction}] executed for ${signalParam}\\n";\n`;
                out += `    }\n\n`;
            }
        });
    }

    out += `};\n\n`;
    out += `#endif // ${upperMachineName}_IMPL_HPP\n`;
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
        };

        // --- AUTO-INITIALIZE EMPTY FILES BASED ON FILENAME ---
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

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

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
                    const stubFilename = `${lowerHsmName}_impl.hpp`;

                    const userResponse = await vscode.window.showWarningMessage(
                        `⚠️ Overwrite Warning: Exporting will completely replace '${blueprintFilename}' and '${stubFilename}' in this directory. Proceed?`,
                        { modal: true },
                        "Yes, Overwrite"
                    );

                    if (userResponse !== "Yes, Overwrite") return;

                    const cppBlueprint = generateCppBlueprintString(jsonText);
                    const cppStub = generateCppConcreteStubString(jsonText);
                    
                    const folderUri = vscode.Uri.joinPath(document.uri, '..');
                    const blueprintUri = vscode.Uri.joinPath(folderUri, blueprintFilename);
                    const stubUri = vscode.Uri.joinPath(folderUri, stubFilename);
                    
                    try {
                        // Write out the fresh binary data streams to disk cleanly using our top-level global helper
                        await vscode.workspace.fs.writeFile(blueprintUri, stringToUint8Array(cppBlueprint));
                        await vscode.workspace.fs.writeFile(stubUri, stringToUint8Array(cppStub));
                        
                        // Synchronize our external runtime hpp framework engine files
                        await copyFrameworkFilesToWorkspace(this.context, folderUri);
                        
                        vscode.window.showInformationMessage(`🚀 Generated ${blueprintFilename} and ${stubFilename} successfully!`);
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

    private getHtmlForWebview(webview: vscode.Webview): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>FreeActors HSM Canvas</title>
                <style>
                    body {
                        margin: 0;
                        padding: 0;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        background-color: var(--vscode-editor-backgroundColor);
                        user-select: none;
                        overflow: hidden;
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                    }
                    #toolbar {
                        padding: 8px;
                        background: var(--vscode-sideBar-background, #252526);
                        display: flex;
                        gap: 10px;
                        align-items: center;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        z-index: 100;
                    }
                    button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 4px 12px;
                        cursor: pointer;
                        border-radius: 2px;
                    }
                    button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    #main-layout {
                        display: flex;
                        flex: 1;
                        height: calc(100vh - 45px);
                        overflow: hidden;
                    }
                    #sidebar-registry {
                        width: 240px;
                        background: var(--vscode-sideBar-background, #252526);
                        border-right: 1px solid var(--vscode-panel-border);
                        display: flex;
                        flex-direction: column;
                        padding: 10px;
                        gap: 15px;
                        overflow-y: auto;
                        box-sizing: border-box;
                        z-index: 10;
                    }
                    .registry-section {
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                    }
                    .registry-header {
                        font-size: 0.85em;
                        font-weight: bold;
                        text-transform: uppercase;
                        opacity: 0.7;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding-bottom: 3px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .registry-list {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        max-height: 120px;
                        overflow-y: auto;
                        padding-right: 2px;
                    }
                    .registry-item {
                        font-size: 0.85em;
                        background: var(--vscode-list-hoverBackground, #2a2a2b);
                        padding: 3px 6px;
                        border-radius: 3px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .registry-item button {
                        background: transparent;
                        padding: 0 4px;
                        color: var(--vscode-errorForeground, #f48771);
                    }
                    .registry-item button:hover {
                        background: rgba(255,0,0,0.1);
                    }
                    #canvas-container {
                        flex: 1;
                        position: relative;
                        overflow: hidden;
                        background-image: radial-gradient(var(--vscode-panel-border, #444) 1px, transparent 1px);
                        background-size: 20px 20px;
                        cursor: grab;
                        z-index: 1; /* FIX: Keeps canvas layers behind top-level workspace modals */
                    }
                    #canvas-container:active {
                        cursor: grabbing;
                    }
                    #workspace-viewport {
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 3000px;
                        height: 3000px;
                        transform-origin: 0 0;
                        will-change: transform;
                    }
                    #svg-layer {
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        z-index: 3;
                        pointer-events: none;
                    }
                    #nodes-layer {
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        z-index: 2;
                        pointer-events: none;
                    }
                    .hsm-state-node {
                        position: absolute;
                        background: var(--vscode-editor-background, #1e1e1e);
                        border: 2px solid var(--vscode-button-background);
                        border-radius: 6px;
                        padding: 10px;
                        min-width: 180px;
                        min-height: 80px;
                        cursor: move;
                        box-shadow: 0 4px 8px rgba(0,0,0,0.4);
                        pointer-events: auto;
                        box-sizing: border-box;
                    }
                    .hsm-state-node.composite {
                        border: 2px dashed var(--vscode-textLink-foreground);
                        background: rgba(255, 255, 255, 0.01);
                    }
                    .hsm-state-node.initial-accent {
                        border-color: var(--vscode-charts-green, #388a34) !important;
                        box-shadow: 0 0 8px rgba(56, 138, 52, 0.4), 0 4px 8px rgba(0,0,0,0.4);
                    }
                    .hsm-state-node.composite.initial-accent {
                        border: 2px dashed var(--vscode-charts-green, #388a34) !important;
                    }
                    .init-badge {
                        background: var(--vscode-charts-green, #388a34);
                        color: #ffffff;
                        font-size: 0.7em;
                        padding: 2px 5px;
                        border-radius: 3px;
                        font-weight: bold;
                        margin-left: 6px;
                    }
                    .hsm-state-node.link-target-candidate {
                        box-shadow: 0 0 14px var(--vscode-textLink-foreground, #007acc) !important;
                        border-color: var(--vscode-textLink-foreground, #007acc) !important;
                    }
                    .hsm-state-header {
                        font-weight: bold;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding-bottom: 4px;
                        margin-bottom: 6px;
                        color: var(--vscode-textLink-foreground);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .hamburger-btn {
                        background: transparent;
                        color: var(--vscode-foreground);
                        padding: 2px 6px;
                        font-size: 14px;
                        cursor: pointer;
                        border-radius: 3px;
                    }
                    .hamburger-btn:hover {
                        background: var(--vscode-list-hoverBackground, #37373d);
                    }
                    .hsm-state-actions {
                        font-size: 0.85em;
                        opacity: 0.8;
                        display: flex;
                        flex-direction: column;
                        gap: 2px;
                    }
                    .transition-clickable-path {
                        cursor: pointer;
                        pointer-events: stroke;
                    }
                    .transition-clickable-path:hover {
                        stroke: var(--vscode-errorForeground, #f48771) !important;
                        stroke-width: 4px !important;
                    }
                    .transition-label {
                        fill: var(--vscode-editor-foreground);
                        font-size: 11px;
                        font-family: sans-serif;
                        pointer-events: none;
                    }
                    .resize-handle {
                        position: absolute;
                        right: 0;
                        bottom: 0;
                        width: 12px;
                        height: 12px;
                        cursor: se-resize;
                        background: linear-gradient(135deg, transparent 30%, var(--vscode-panel-border) 30%, var(--vscode-panel-border) 50%, transparent 50%, transparent 70%, var(--vscode-panel-border) 70%);
                        background-size: 4px 4px;
                        border-bottom-right-radius: 4px;
                    }
                    .initial-pseudostate-dot {
                        position: absolute;
                        width: 12px;
                        height: 12px;
                        background-color: var(--vscode-charts-blue, #007acc);
                        border: 2px solid #ffffff;
                        border-radius: 50%;
                        cursor: crosshair;
                        z-index: 10;
                    }
                    .initial-pseudostate-dot:hover {
                        transform: scale(1.2);
                        box-shadow: 0 0 6px var(--vscode-charts-blue, #007acc);
                    }
                    .context-menu {
                        position: absolute;
                        background: var(--vscode-menu-background, #252526);
                        color: var(--vscode-menu-foreground, #cccccc);
                        border: 1px solid var(--vscode-menu-border, #454545);
                        border-radius: 4px;
                        box-shadow: 0 4px 10px rgba(0,0,0,0.5);
                        z-index: 1000;
                        display: none;
                        flex-direction: column;
                        padding: 4px 0;
                        min-width: 160px;
                    }
                    .context-menu-item {
                        padding: 6px 12px;
                        cursor: pointer;
                        font-size: 0.9em;
                    }
                    .context-menu-item:hover {
                        background: var(--vscode-menu-selectionBackground, #007acc);
                        color: var(--vscode-menu-selectionForeground, #ffffff);
                    }
                    .modal-overlay {
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100vw;
                        height: 100vh; /* FIX: Force to view height, not width! */
                        background: rgba(0, 0, 0, 0.6);
                        display: none;
                        justify-content: center;
                        align-items: center;
                        z-index: 2000;
                    }
                    .modal-box {
                        background: var(--vscode-sideBar-background, #252526);
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 6px;
                        padding: 16px;
                        width: 320px; /* Slightly wider for clear input padding fields */
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                        box-shadow: 0 4px 15px rgba(0,0,0,0.6);
                        box-sizing: border-box; /* FIX: Prevents inner inputs from bleeding over borders */
                    }
                    .modal-box h3 {
                        margin: 0;
                        font-size: 1.1em;
                        color: var(--vscode-textLink-foreground);
                    }
                    .modal-box input, .modal-box select {
                        background: var(--vscode-input-background, #3c3c3c);
                        color: var(--vscode-input-foreground, #cccccc);
                        border: 1px solid var(--vscode-input-border, #6b6b6b);
                        padding: 6px;
                        border-radius: 2px;
                    }
                    .modal-buttons {
                        display: flex;
                        justify-content: flex-end;
                        gap: 8px;
                        margin-top: 4px;
                    }
                    .validation-hint {
                        font-size: 0.8em;
                        color: var(--vscode-textPreformat-foreground, #d7ba7d);
                        margin-top: -6px;
                        display: none;
                    }
                    .local-event-row:hover .del-event-btn {
                        display: inline-block !important;
                        cursor: pointer;
                    }
                    .del-event-btn:hover {
                        background: rgba(244, 135, 113, 0.2) !important;
                        border-radius: 2px;
                    }
                </style>
            </head>
            <body>
                <div id="toolbar">
                    <strong>FreeActors HSM Workspace</strong>
                    <button id="add-state-btn">+ Add Root State</button>
                    <button id="reset-view-btn">🏠 Reset View</button>
                    <button id="export-cpp-btn" style="background:var(--vscode-charts-blue, #007acc);">💾 Export C++ Blueprint</button>
                    <span id="zoom-readout">Zoom: 100%</span>
                    <span id="linking-hint" style="color:var(--vscode-textLink-foreground); font-size:0.9em; margin-left:15px; display:none;">ℹ️ Click target state card (Esc or Right-Click to cancel)</span>
                </div>
                
                <div id="main-layout">
                    <div id="sidebar-registry">
                        <div class="registry-section">
                            <div class="registry-header">
                                <span>Signals (Events)</span>
                                <button id="add-reg-signal" style="padding: 1px 6px; font-size: 11px;">+</button>
                            </div>
                            <div id="list-signals" class="registry-list"></div>
                        </div>
                        <div class="registry-section">
                            <div class="registry-header">
                                <span>Guards (Queries)</span>
                                <button id="add-reg-guard" style="padding: 1px 6px; font-size: 11px;">+</button>
                            </div>
                            <div id="list-guards" class="registry-list"></div>
                        </div>
                        <div class="registry-section">
                            <div class="registry-header">
                                <span>Actions (Routines)</span>
                                <button id="add-reg-action" style="padding: 1px 6px; font-size: 11px;">+</button>
                            </div>
                            <div id="list-actions" class="registry-list"></div>
                        </div>
                    </div>

                    <div id="canvas-container">
                        <div id="workspace-viewport">
                            <svg id="svg-layer">
                                <defs>
                                    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-button-background)" />
                                    </marker>
                                    <marker id="rubber-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                                        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vscode-textLink-foreground)" />
                                    </marker>
                                </defs>
                                <svg id="links-group"></svg>
                                <path id="rubber-band-path" stroke="var(--vscode-textLink-foreground)" stroke-dasharray="4 4" stroke-width="2" fill="none" marker-end="url(#rubber-arrow)" style="display:none;"></path>
                            </svg>
                            <div id="nodes-layer"></div>
                        </div>
                    </div>
                </div>

                <div id="state-context-menu" class="context-menu">
                    <div class="context-menu-item" id="menu-add-transition">➡️ Add Transition Link</div>
                    <div class="context-menu-item" id="menu-add-event">⚡ Add Handled Event</div>
                    <div class="context-menu-item" id="menu-add-substate">📁 Add Sub-State</div>
                    <div class="context-menu-item" id="menu-change-parent">⚙️ Change Parent...</div>
                    <div class="context-menu-item" id="menu-rename-state">✏️ Rename State...</div>
                    <hr style="border:0; border-top:1px solid var(--vscode-panel-border); margin:4px 0;">
                    <div class="context-menu-item" id="menu-delete-state" style="color:var(--vscode-errorForeground, #f48771);">❌ Delete State</div>
                </div>

                <div id="asset-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3 id="asset-modal-title">Declare Global Asset</h3>
                        <input type="text" id="input-asset-name" placeholder="Identifiers (e.g. EV_START, EV_STOP, EV_FAULT)">
                        <div class="modal-buttons">
                            <button id="btn-cancel-asset" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-asset">Register</button>
                        </div>
                    </div>
                </div>

                <div id="transition-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3 id="transition-modal-title">Configure Transition</h3>
                        <input type="text" id="input-trans-event" placeholder="Signal (e.g. EV_START)">
                        <div id="hint-trans-event" class="validation-hint">⚠️ New Signal identifier. Will auto-register.</div>
                        <input type="text" id="input-trans-guard" placeholder="Guard Condition (Optional)">
                        <div id="hint-trans-guard" class="validation-hint">⚠️ New Guard identifier. Will auto-register.</div>
                        <input type="text" id="input-trans-action" placeholder="Transition Action Routine (Optional)">
                        <div id="hint-trans-action" class="validation-hint">⚠️ New Action identifier. Will auto-register.</div>
                        <div class="modal-buttons">
                            <button id="btn-cancel-trans" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-trans">Bind Link</button>
                        </div>
                    </div>
                </div>

                <div id="event-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Add Handled Event</h3>
                        <input type="text" id="input-signal" placeholder="Signal Name">
                        <div id="hint-event-signal" class="validation-hint">⚠️ New Signal identifier. Will auto-register.</div>
                        <input type="text" id="input-action" placeholder="Action Routine (Optional)">
                        <div id="hint-event-action" class="validation-hint">⚠️ New Action identifier. Will auto-register.</div>
                        <div class="modal-buttons">
                            <button id="btn-cancel-event" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-event">Add</button>
                        </div>
                    </div>
                </div>

                <div id="parent-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Change Parent State</h3>
                        <p style="margin:0; font-size:0.85em; opacity:0.8;">Select a container state for this node:</p>
                        <select id="select-parent-node"></select>
                        <div class="modal-buttons">
                            <button id="btn-cancel-parent" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-parent">Update Hierarchy</button>
                        </div>
                    </div>
                </div>

                <div id="delete-state-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Delete State?</h3>
                        <p style="margin:0; font-size:0.9em; opacity:0.8;">This will remove this state, orphan sub-states, and purge dependent links.</p>
                        <div class="modal-buttons">
                            <button id="btn-cancel-delstate" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-confirm-delstate" style="background:var(--vscode-statusBarItem-errorBackground, #c74848);">Delete</button>
                        </div>
                    </div>
                </div>

                <div id="delete-trans-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Remove Transition?</h3>
                        <p id="delete-trans-text" style="margin:0; font-size:0.9em; opacity:0.8;">Remove connection?</p>
                        <div class="modal-buttons">
                            <button id="btn-cancel-deltrans" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-confirm-deltrans" style="background:var(--vscode-statusBarItem-errorBackground, #c74848);">Remove</button>
                        </div>
                    </div>
                </div>

                <div id="substate-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Add Sub-State</h3>
                        <input type="text" id="input-subname" placeholder="Sub-State Name">
                        <div id="error-substate" style="color:var(--vscode-errorForeground, #f48771); font-size:0.85em; display:none; margin-top:-4px;">❌ State name must be unique!</div>
                        <div class="modal-buttons">
                            <button id="btn-cancel-substate" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-substate">Add Sub-State</button>
                        </div>
                    </div>
                </div>
                
                <div id="rootstate-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Add Root State</h3>
                        <input type="text" id="input-rootname" placeholder="State Name (e.g. IDLE, RUNNING)">
                        <div id="error-rootstate" style="color:var(--vscode-errorForeground, #f48771); font-size:0.85em; display:none; margin-top:-4px;">❌ State name must be unique!</div>
                        <div class="modal-buttons">
                            <button id="btn-cancel-rootstate" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-rootstate">Create State</button>
                        </div>
                    </div>
                </div>

                <div id="rename-modal" class="modal-overlay">
                    <div class="modal-box">
                        <h3>Rename State</h3>
                        <input type="text" id="input-rename-name" placeholder="New State Name">
                        <div id="error-rename" style="color:var(--vscode-errorForeground, #f48771); font-size:0.85em; display:none; margin-top:-4px;">❌ State name must be unique!</div>
                        <div class="modal-buttons">
                            <button id="btn-cancel-rename" style="background:transparent; border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground);">Cancel</button>
                            <button id="btn-submit-rename">Apply Name</button>
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const nodesLayer = document.getElementById('nodes-layer');
                    const linksGroup = document.getElementById('links-group');
                    const contextMenu = document.getElementById('state-context-menu');
                    const canvasContainer = document.getElementById('canvas-container');
                    const viewport = document.getElementById('workspace-viewport');
                    
                    const transitionModal = document.getElementById('transition-modal');
                    const eventModal = document.getElementById('event-modal');
                    const substateModal = document.getElementById('substate-modal');
                    const deleteStateModal = document.getElementById('delete-state-modal');
                    const deleteTransModal = document.getElementById('delete-trans-modal');
                    const parentModal = document.getElementById('parent-modal');
                    const assetModal = document.getElementById('asset-modal');
                    
                    const selectParentNode = document.getElementById('select-parent-node');
                    const rubberBandPath = document.getElementById('rubber-band-path');
                    const linkingHint = document.getElementById('linking-hint');
                    const zoomReadout = document.getElementById('zoom-readout');

                    let currentHsmData = { name: "ActorMachine", signals: [], guards: [], actions: [], states: [] };
                    let activeMenuStateId = null;
                    let assetTargetType = '';
                    
                    let isLinkingMode = false;
                    let isLinkingFromInitDot = false;
                    let linkSourceStateId = null;
                    let linkTargetStateId = null;

                    let activeDelSourceId = null;
                    let activeDelTransIndex = null;

                    let scale = 1.0; let panX = 0; let panY = 0;
                    let isPanning = false; let startPanX = 0; let startPanY = 0;

                    function applyTransformMatrix() {
                        viewport.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
                        canvasContainer.style.backgroundSize = \`\${20 * scale}px \${20 * scale}px\`;
                        canvasContainer.style.backgroundPosition = \`\${panX}px \${panY}px\`;
                        zoomReadout.innerText = \`Zoom: \${Math.round(scale * 100)}%\`;
                    }

                    canvasContainer.addEventListener('wheel', (e) => {
                        e.preventDefault();
                        const zoomIntensity = 0.05;
                        const rect = canvasContainer.getBoundingClientRect();
                        const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
                        const viewportMouseX = (mouseX - panX) / scale; const viewportMouseY = (mouseY - panY) / scale;
                        const delta = e.deltaY < 0 ? 1 : -1;
                        const nextScale = Math.min(Math.max(0.3, scale + delta * zoomIntensity), 2.5);
                        panX = mouseX - viewportMouseX * nextScale; panY = mouseY - viewportMouseY * nextScale;
                        scale = nextScale;
                        applyTransformMatrix();
                    });

                    canvasContainer.addEventListener('mousedown', (e) => {
                        if (e.target !== canvasContainer && e.target.id !== 'workspace-viewport' && e.target.id !== 'svg-layer') return;
                        if (isLinkingMode) return;
                        isPanning = true; startPanX = e.clientX - panX; startPanY = e.clientY - panY;
                    });
                    window.addEventListener('mousemove', (e) => {
                        if (!isPanning) return; panX = e.clientX - startPanX; panY = e.clientY - startPanY; applyTransformMatrix();
                    });
                    window.addEventListener('mouseup', () => { isPanning = false; });
                    document.getElementById('reset-view-btn').addEventListener('click', () => { scale = 1.0; panX = 0; panY = 0; applyTransformMatrix(); });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'update') {
                            try {
                                const parsed = JSON.parse(message.text || '{"states":[]}');
                                currentHsmData.name = parsed.name || "ActorMachine";
                                currentHsmData.signals = parsed.signals || [];
                                currentHsmData.guards = parsed.guards || [];
                                currentHsmData.actions = parsed.actions || [];
                                currentHsmData.states = parsed.states || [];
                                
                                renderHsmWorkspace();
                                renderSidebarRegistry();
                            } catch(e) {
                                nodesLayer.innerHTML = '<div style="color:red; padding:20px;">Invalid HSM JSON Structure</div>';
                            }
                        }
                    });

                    window.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape' && isLinkingMode) cancelLinkingMode();
                    });
                    canvasContainer.addEventListener('contextmenu', (e) => {
                        if (isLinkingMode) { e.preventDefault(); cancelLinkingMode(); }
                    });
                    
                    canvasContainer.addEventListener('click', (e) => {
                        if (!isLinkingMode) return;
                        
                        const targetNode = e.target.closest('.hsm-state-node');
                        if (!targetNode) return;
                        
                        const targetId = targetNode.id.replace('node-', '');
                        if (targetId === linkSourceStateId && isLinkingFromInitDot) return; 
                        
                        e.stopPropagation();
                        linkTargetStateId = targetId;
                        
                        rubberBandPath.style.display = 'none';
                        window.removeEventListener('mousemove', onRubberBandMove);
                        
                        const eventInput = document.getElementById('input-trans-event');
                        const actionInput = document.getElementById('input-trans-action');
                        const hintAction = document.getElementById('hint-trans-action');
                        
                        actionInput.value = '';
                        hintAction.style.display = 'none';

                        if (isLinkingFromInitDot) {
                            eventInput.value = 'Init_sig';
                            eventInput.disabled = true;
                            actionInput.style.display = 'none';
                            document.getElementById('transition-modal-title').innerText = 'Configure Initial Transition';
                        } else {
                            eventInput.value = '';
                            eventInput.disabled = false;
                            actionInput.style.display = 'block';
                            document.getElementById('transition-modal-title').innerText = 'Configure Transition';
                        }
                        
                        document.getElementById('input-trans-guard').value = '';
                        document.getElementById('hint-trans-event').style.display = 'none';
                        document.getElementById('hint-trans-guard').style.display = 'none';
                        transitionModal.style.display = 'flex';
                    });
                    document.addEventListener('click', () => { contextMenu.style.display = 'none'; });

                    function renderSidebarRegistry() {
                        const signalRefs = {};
                        const guardRefs = {};
                        const actionRefs = {};

                        if (currentHsmData.signals) {
                            currentHsmData.signals.forEach(sig => { signalRefs[sig.toUpperCase()] = 0; });
                        }
                        if (currentHsmData.guards) {
                            currentHsmData.guards.forEach(g => { guardRefs[g.toUpperCase()] = 0; });
                        }
                        if (currentHsmData.actions) {
                            currentHsmData.actions.forEach(act => { actionRefs[act.toUpperCase()] = 0; });
                        }

                        if (currentHsmData.states) {
                            currentHsmData.states.forEach(s => {
                                if (s.entry) {
                                    const entryKey = s.entry.toUpperCase();
                                    if (entryKey in actionRefs) actionRefs[entryKey]++;
                                }
                                if (s.exit) {
                                    const exitKey = s.exit.toUpperCase();
                                    if (exitKey in actionRefs) actionRefs[exitKey]++;
                                }

                                if (s.local_events && Array.isArray(s.local_events)) {
                                    s.local_events.forEach(ev => {
                                        if (typeof ev === 'string') {
                                            const cleanEv = ev.replace('·', '').trim().toUpperCase();
                                            if (cleanEv.includes('/')) {
                                                const parts = cleanEv.split('/');
                                                const sigPart = parts[0] ? parts[0].trim() : '';
                                                const actPart = parts[1] ? parts[1].trim() : '';
                                                if (sigPart in signalRefs) signalRefs[sigPart]++;
                                                if (actPart in actionRefs) actionRefs[actPart]++;
                                            } else {
                                                if (cleanEv in signalRefs) signalRefs[cleanEv]++;
                                                if (cleanEv in actionRefs) actionRefs[cleanEv]++;
                                            }
                                        }
                                    });
                                }

                                if (s.transitions && Array.isArray(s.transitions)) {
                                    s.transitions.forEach(t => {
                                        if (t.event) {
                                            const eventKey = t.event.toUpperCase();
                                            if (eventKey in signalRefs) signalRefs[eventKey]++;
                                        }
                                        if (t.guard) {
                                            const guardKey = t.guard.toUpperCase();
                                            if (guardKey in guardRefs) guardRefs[guardKey]++;
                                        }
                                    });
                                }
                            });
                        }

                        populateRegistryList('list-signals', currentHsmData.signals, 'signals', signalRefs, '⚡ ');
                        populateRegistryList('list-guards', currentHsmData.guards, 'guards', guardRefs, '🔍 ');
                        populateRegistryList('list-actions', currentHsmData.actions, 'actions', actionRefs, '⚙️ ');
                    }

                    function populateRegistryList(elementId, itemsList, typeKey, refMap, iconPrefix) {
                        const container = document.getElementById(elementId);
                        if (!container) return;
                        container.innerHTML = '';
                        
                        if(!itemsList || itemsList.length === 0) {
                            container.innerHTML = '<div style="font-size:0.8em; opacity:0.4; font-style:italic; padding:2px 5px;">None</div>';
                            return;
                        }
                        
                        itemsList.forEach((item) => {
                            if (item === 'Init_sig' || item === 'Enter_sig' || item === 'Exit_sig' || item === 'ExitToParent_sig') return;
                            
                            const itemEl = document.createElement('div');
                            itemEl.className = 'registry-item';
                            
                            const count = refMap[item.toUpperCase()] || 0;
                            
                            const textSpan = document.createElement('span');
                            textSpan.innerText = iconPrefix + item + ' (' + count + ')';
                            itemEl.appendChild(textSpan);
                            
                            if (count === 0) {
                                const delBtn = document.createElement('button');
                                delBtn.innerText = '×';
                                delBtn.setAttribute('data-item', item);
                                delBtn.style.background = 'transparent';
                                delBtn.style.border = 'none';
                                delBtn.style.cursor = 'pointer';
                                
                                delBtn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    currentHsmData[typeKey] = currentHsmData[typeKey].filter(i => i !== item);
                                    commitHsmChange();
                                    renderSidebarRegistry();
                                });
                                itemEl.appendChild(delBtn);
                            }
                            
                            container.appendChild(itemEl);
                        });
                    }

                    function openAssetModal(type, title) {
                        assetTargetType = type;
                        document.getElementById('asset-modal-title').innerText = title;
                        document.getElementById('input-asset-name').value = '';
                        assetModal.style.display = 'flex';
                    }
                    document.getElementById('add-reg-signal').addEventListener('click', () => openAssetModal('signals', 'Declare Global Signal'));
                    document.getElementById('add-reg-guard').addEventListener('click', () => openAssetModal('guards', 'Declare Global Guard'));
                    document.getElementById('add-reg-action').addEventListener('click', () => openAssetModal('actions', 'Declare Global Action'));
                    document.getElementById('btn-cancel-asset').addEventListener('click', () => assetModal.style.display = 'none');
                    
                    document.getElementById('btn-submit-asset').addEventListener('click', () => {
                        const rawInput = document.getElementById('input-asset-name').value;
                        if (!rawInput) return;
                        
                        const incomingAssets = rawInput
                            .split(',')
                            .map(item => item.trim())
                            .filter(item => item.length > 0);
                            
                        if (incomingAssets.length === 0) return;

                        let holdsChanges = false;
                        
                        incomingAssets.forEach(asset => {
                            if (!currentHsmData[assetTargetType].includes(asset)) {
                                currentHsmData[assetTargetType].push(asset);
                                holdsChanges = true;
                            }
                        });

                        if (holdsChanges) {
                            commitHsmChange();
                        }
                        
                        assetModal.style.display = 'none';
                    });

                    setupLiveValidation('input-trans-event', 'hint-trans-event', 'signals');
                    setupLiveValidation('input-trans-guard', 'hint-trans-guard', 'guards');
                    setupLiveValidation('input-signal', 'hint-event-signal', 'signals');
                    setupLiveValidation('input-action', 'hint-event-action', 'actions');
                    setupLiveValidation('input-trans-action', 'hint-trans-action', 'actions');

                    function setupLiveValidation(inputId, hintId, registryKey) {
                        const input = document.getElementById(inputId);
                        const hint = document.getElementById(hintId);
                        input.addEventListener('input', () => {
                            const val = input.value.trim();
                            if (!val || val === 'Init_sig' || currentHsmData[registryKey].includes(val)) {
                                hint.style.display = 'none';
                            } else {
                                hint.style.display = 'block';
                            }
                        });
                    }

                    function renderHsmWorkspace() {
                        nodesLayer.innerHTML = ''; linksGroup.innerHTML = '';

                        const addRootBtn = document.getElementById('add-state-btn');
                        if (addRootBtn) {
                            const hasRootState = currentHsmData.states && currentHsmData.states.some(s => !s.parent);
                            if (hasRootState) {
                                addRootBtn.disabled = true;
                                addRootBtn.style.opacity = '0.4';
                                addRootBtn.style.cursor = 'not-allowed';
                            } else {
                                addRootBtn.disabled = false;
                                addRootBtn.style.opacity = '1';
                                addRootBtn.style.cursor = 'pointer';
                            }
                        }

                        if (!currentHsmData.states || currentHsmData.states.length === 0) {
                            nodesLayer.innerHTML = '<div style="opacity:0.5; padding:40px; text-align:center;">Canvas Empty.</div>';
                            return;
                        }

                        currentHsmData.states.forEach((state, index) => {
                            const node = document.createElement('div');
                            node.id = 'node-' + state.id;
                            const isParent = currentHsmData.states.some(s => s.parent === state.id);

                            node.className = 'hsm-state-node' + (isParent ? ' composite' : '');
                            node.style.left = state.x + 'px'; node.style.top = state.y + 'px';
                            node.style.width = (state.width || 180) + 'px'; node.style.height = (state.height || 90) + 'px';

                            let internalEventsHtml = '';
                            if (state.local_events) {
                                state.local_events.forEach((ev, evIdx) => {
                                    internalEventsHtml += \`
                                        <div class="local-event-row" style="color:var(--vscode-charts-purple, #b15c87); display:flex; justify-content:space-between; align-items:center; font-size:0.95em;">
                                            <span>⚡ \${ev}</span>
                                            <button class="del-event-btn" data-state-index="\${index}" data-event-index="\${evIdx}" style="background:transparent; padding:0 4px; color:var(--vscode-errorForeground, #f48771); display:none; font-size:11px;">×</button>
                                        </div>
                                    \`;
                                });
                            }

                            node.innerHTML = \`
                                <div class="hsm-state-header">
                                    <div style="display:flex; align-items:center;">
                                        <span>\${state.name}</span>
                                    </div>
                                    <button class="hamburger-btn" data-state-id="\${state.id}">☰</button>
                                </div>
                                <div class="hsm-state-actions">
                                    \---state_actions_hook---
                                    \${state.entry ? '<div>↳ 🟡 ' + state.entry + '</div>' : ''}
                                    \${state.exit ? '<div>↱ 🔴 ' + state.exit + '</div>' : ''}
                                    \${state.parent ? '<div style="font-size:0.8em; opacity:0.6; font-style:italic;">Parent: ' + state.parent + '</div>' : ''}
                                    \${internalEventsHtml}
                                </div>
                                <div class="resize-handle"></div>
                            \`.replace('\\---state_actions_hook---', '');

                            if (isParent || !state.parent) {
                                const initDot = document.createElement('div');
                                initDot.className = 'initial-pseudostate-dot';
                                initDot.title = "Drag connection wire to target Init_sig default child state.";
                                initDot.style.left = (state.width ? (state.width - 46) : 134) + 'px'; 
                                initDot.style.top = '10px'; 

                                initDot.addEventListener('mousedown', (e) => e.stopPropagation());
                                initDot.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    isLinkingMode = true;
                                    isLinkingFromInitDot = true;
                                    linkSourceStateId = state.id;
                                    linkingHint.style.display = 'inline';
                                    canvasContainer.style.cursor = 'crosshair';
                                    window.addEventListener('mousemove', onRubberBandMove);
                                });
                                node.appendChild(initDot);
                            }

                            const menuBtn = node.querySelector('.hamburger-btn');
                            menuBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                            menuBtn.addEventListener('click', (e) => {
                                e.stopPropagation(); activeMenuStateId = state.id;
                                const rect = menuBtn.getBoundingClientRect();
                                contextMenu.style.left = (rect.left + window.scrollX) + 'px'; contextMenu.style.top = (rect.bottom + window.scrollY) + 'px';
                                
                                const deleteOptionEl = document.getElementById('menu-delete-state');
                                const changeParentOptionEl = document.getElementById('menu-change-parent');
                                
                                if (!state.parent) {
                                    if (deleteOptionEl) deleteOptionEl.style.display = 'none';
                                    if (changeParentOptionEl) changeParentOptionEl.style.display = 'none';
                                } else {
                                    if (deleteOptionEl) deleteOptionEl.style.display = 'block';
                                    if (changeParentOptionEl) changeParentOptionEl.style.display = 'block';
                                }

                                contextMenu.style.display = 'flex';
                            });

                            node.addEventListener('mouseenter', () => { 
                                if (isLinkingMode) {
                                    if (isLinkingFromInitDot && state.id === linkSourceStateId) return;
                                    node.classList.add('link-target-candidate'); 
                                }
                            });
                            node.addEventListener('mouseleave', () => { node.classList.remove('link-target-candidate'); });
                            
                            setupDragAndResize(node, index);
                            nodesLayer.appendChild(node);

                            node.querySelectorAll('.del-event-btn').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    const stateIdx = parseInt(btn.getAttribute('data-state-index'));
                                    const eventIdx = parseInt(btn.getAttribute('data-event-index'));
                                    if (currentHsmData.states[stateIdx] && currentHsmData.states[stateIdx].local_events) {
                                        currentHsmData.states[stateIdx].local_events.splice(eventIdx, 1);
                                        commitHsmChange();
                                        renderHsmWorkspace();
                                        renderSidebarRegistry();
                                    }
                                });
                            });
                        });

                        updateAllTransitions();
                        applyTransformMatrix();
                    }

                    document.getElementById('menu-change-parent').addEventListener('click', () => {
                        selectParentNode.innerHTML = '';
                        const rootOpt = document.createElement('option');
                        rootOpt.value = '__NONE__'; rootOpt.innerText = '[ None / Root Level ]';
                        selectParentNode.appendChild(rootOpt);
                        const targetState = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        currentHsmData.states.forEach(s => {
                            if (s.id !== activeMenuStateId && s.parent !== activeMenuStateId) {
                                const opt = document.createElement('option'); opt.value = s.id; opt.innerText = \`\${s.name} (\${s.id})\`;
                                if (targetState && targetState.parent === s.id) opt.selected = true;
                                selectParentNode.appendChild(opt);
                            }
                        });
                        parentModal.style.display = 'flex';
                    });
                    document.getElementById('btn-cancel-parent').addEventListener('click', () => parentModal.style.display = 'none');
                    document.getElementById('btn-submit-parent').addEventListener('click', () => {
                        const chosenParentId = selectParentNode.value;
                        const state = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        if (state) {
                            if (chosenParentId === '__NONE__') { delete state.parent; } else { state.parent = chosenParentId; }
                            commitHsmChange();
                            renderHsmWorkspace();
                        }
                        parentModal.style.display = 'none';
                    });

                    document.getElementById('menu-delete-state').addEventListener('click', () => { deleteStateModal.style.display = 'flex'; });
                    document.getElementById('btn-cancel-delstate').addEventListener('click', () => deleteStateModal.style.display = 'none');
                    document.getElementById('btn-confirm-delstate').addEventListener('click', () => {
                        const targetId = activeMenuStateId;
                        currentHsmData.states = currentHsmData.states.filter(s => s.id !== targetId);
                        currentHsmData.states.forEach(s => { if (s.parent === targetId) delete s.parent; });
                        currentHsmData.states.forEach(s => { if (s.transitions) s.transitions = s.transitions.filter(t => t.target !== targetId); });
                        commitHsmChange();
                        renderHsmWorkspace();
                        deleteStateModal.style.display = 'none';
                    });

                    document.getElementById('btn-cancel-deltrans').addEventListener('click', () => deleteTransModal.style.display = 'none');
                    document.getElementById('btn-confirm-deltrans').addEventListener('click', () => {
                        const state = currentHsmData.states.find(s => s.id === activeDelSourceId);
                        if (state && state.transitions) {
                            state.transitions.splice(activeDelTransIndex, 1);
                            commitHsmChange();
                            renderHsmWorkspace();
                        }
                        deleteTransModal.style.display = 'none';
                    });

                    document.getElementById('menu-add-transition').addEventListener('click', () => {
                        isLinkingMode = true; 
                        isLinkingFromInitDot = false;
                        linkSourceStateId = activeMenuStateId;
                        linkingHint.style.display = 'inline'; canvasContainer.style.cursor = 'crosshair';
                        window.addEventListener('mousemove', onRubberBandMove);
                    });

                    let lastHoveredNodeEl = null;

                    function onRubberBandMove(e) {
                        if (!isLinkingMode) return;
                        const srcEl = document.getElementById('node-' + linkSourceStateId);
                        if (!srcEl) return;
                        
                        const rect = canvasContainer.getBoundingClientRect();
                        const mouseX = (e.clientX - rect.left - panX) / scale;
                        const mouseY = (e.clientY - rect.top - panY) / scale;
                        
                        let edgeX1, edgeY1;
                        
                        if (isLinkingFromInitDot) {
                            edgeX1 = srcEl.offsetLeft + srcEl.offsetWidth - 40;
                            edgeY1 = srcEl.offsetTop + 16;
                        } else {
                            const w = srcEl.offsetWidth / 2;
                            const h = srcEl.offsetHeight / 2;
                            const srcCenterX = srcEl.offsetLeft + w;
                            const srcCenterY = srcEl.offsetTop + h;
                            const dx = mouseX - srcCenterX;
                            const dy = mouseY - srcCenterY;
                            edgeX1 = srcCenterX; edgeY1 = srcCenterY;
                            if (dx !== 0 || dy !== 0) {
                                const t = Math.min(Math.abs(w / dx), Math.abs(h / dy));
                                edgeX1 = srcCenterX + dx * t;
                                edgeY1 = srcCenterY + dy * t;
                            }
                        }
                        
                        const mx = (edgeX1 + mouseX) / 2;
                        const my = (edgeY1 + mouseY) / 2;
                        const dx_tot = mouseX - edgeX1;
                        const dy_tot = mouseY - edgeY1;
                        const dist = Math.sqrt(dx_tot * dx_tot + dy_tot * dy_tot) || 1;
                        const cx = mx - (dy_tot / dist) * 30;
                        const cy = my + (dx_tot / dist) * 30;
                        
                        rubberBandPath.setAttribute('d', \`M \${edgeX1} \${edgeY1} Q \${cx} \${cy} \${mouseX} \${mouseY}\`);
                        rubberBandPath.style.display = 'block';

                        let foundTargetNode = null;
                        const stateNodes = document.querySelectorAll('.hsm-state-node');
                        
                        for (let node of stateNodes) {
                            if (isLinkingFromInitDot && node.id === 'node-' + linkSourceStateId) continue;
                            if (!isLinkingFromInitDot && node.id === 'node-' + linkSourceStateId) continue;
                            
                            const nodeRect = node.getBoundingClientRect();
                            if (e.clientX >= nodeRect.left && e.clientX <= nodeRect.right &&
                                e.clientY >= nodeRect.top && e.clientY <= nodeRect.bottom) {
                                foundTargetNode = node;
                                break;
                            }
                        }

                        if (foundTargetNode) {
                            if (lastHoveredNodeEl !== foundTargetNode) {
                                if (lastHoveredNodeEl) lastHoveredNodeEl.classList.remove('link-target-candidate');
                                foundTargetNode.classList.add('link-target-candidate');
                                lastHoveredNodeEl = foundTargetNode;
                            }
                        } else {
                            if (lastHoveredNodeEl) {
                                lastHoveredNodeEl.classList.remove('link-target-candidate');
                                lastHoveredNodeEl = null;
                            }
                        }
                    }

                    function cancelLinkingMode() {
                        isLinkingMode = false;
                        isLinkingFromInitDot = false;
                        linkSourceStateId = null;
                        linkTargetStateId = null;
                        rubberBandPath.style.display = 'none';
                        linkingHint.style.display = 'none';
                        canvasContainer.style.cursor = 'default';
                        window.removeEventListener('mousemove', onRubberBandMove);
                        
                        if (lastHoveredNodeEl) {
                            lastHoveredNodeEl.classList.remove('link-target-candidate');
                            lastHoveredNodeEl = null;
                        }
                        document.querySelectorAll('.hsm-state-node').forEach(n => n.classList.remove('link-target-candidate'));
                    }

                    document.getElementById('btn-cancel-trans').addEventListener('click', () => { transitionModal.style.display = 'none'; cancelLinkingMode(); });
                    
                    document.getElementById('btn-submit-trans').addEventListener('click', () => {
                        const eventName = document.getElementById('input-trans-event').value.trim();
                        const guardName = document.getElementById('input-trans-guard').value.trim();
                        const actionInputText = document.getElementById('input-trans-action').value.trim();
                        if (!eventName) return;

                        const cleanActionName = actionInputText.replace('()', '').trim();

                        if (eventName !== 'Init_sig' && !currentHsmData.signals.includes(eventName)) currentHsmData.signals.push(eventName);
                        if (guardName && !currentHsmData.guards.includes(guardName)) currentHsmData.guards.push(guardName);
                        if (cleanActionName && !currentHsmData.actions.includes(cleanActionName)) currentHsmData.actions.push(cleanActionName);

                        const sourceState = currentHsmData.states.find(s => s.id === linkSourceStateId);
                        if (sourceState) {
                            if (!sourceState.transitions) sourceState.transitions = [];
                            
                            const finalEventString = actionInputText ? eventName + " / " + actionInputText : eventName;
                            const newTrans = { event: finalEventString, target: linkTargetStateId };
                            if (guardName) newTrans.guard = guardName;
                            
                            sourceState.transitions.push(newTrans);
                            
                            commitHsmChange();
                            renderHsmWorkspace();
                            renderSidebarRegistry();
                        }
                        transitionModal.style.display = 'none'; 
                        cancelLinkingMode();
                    });

                    function updateAllTransitions() {
                        linksGroup.innerHTML = ''; const linkCounts = {};
                        currentHsmData.states.forEach(state => {
                            if (state.transitions) {
                                state.transitions.forEach((trans, transIdx) => {
                                    const idArray = [state.id, trans.target].sort();
                                    const pairKey = \`\${idArray[0]}<->\${idArray[1]}\`;
                                    if(!linkCounts[pairKey]) linkCounts[pairKey] = 0;
                                    linkCounts[pairKey]++; const index = linkCounts[pairKey];
                                    
                                    let baseCurve = 35; if (index > 1) baseCurve = 35 + (Math.floor(index / 2) * 30);
                                    let finalCurveness = state.id === idArray[0] ? baseCurve : -baseCurve;
                                    if (index > 2 && index % 2 === 0) finalCurveness = -finalCurveness;
                                    
                                    const isInitialLink = trans.event.startsWith('Init_sig');
                                    drawTransitionLink(state.id, trans.target, trans.event, trans.guard, finalCurveness, transIdx, isInitialLink, trans);
                                });
                            }
                        });
                    }

                    function drawTransitionLink(sourceId, targetId, eventName, guardName, curveness, transIdx, isInitialLink, transData) {
                        const srcEl = document.getElementById('node-' + sourceId); const dstEl = document.getElementById('node-' + targetId);
                        if (!srcEl || !dstEl) return;
                        
                        let srcCenterX, srcCenterY;
                        if (isInitialLink) {
                            srcCenterX = srcEl.offsetLeft + srcEl.offsetWidth - 40;
                            srcCenterY = srcEl.offsetTop + 16;
                        } else {
                            srcCenterX = srcEl.offsetLeft + (srcEl.offsetWidth / 2);
                            srcCenterY = srcEl.offsetTop + (srcEl.offsetHeight / 2);
                        }
                        
                        const dstCenterX = dstEl.offsetLeft + (dstEl.offsetWidth / 2); const dstCenterY = dstEl.offsetTop + (dstEl.offsetHeight / 2);
                        const mx = (srcCenterX + dstCenterX) / 2; const my = (srcCenterY + dstCenterY) / 2;
                        const dx = dstCenterX - srcCenterX; const dy = dstCenterY - srcCenterY; const distance = Math.sqrt(dx * dx + dy * dy) || 1;
                        
                        let cx = mx - (dy / distance) * curveness; 
                        let cy = my + (dx / distance) * curveness;
                        
                        if (transData.ctrlX !== undefined && transData.ctrlY !== undefined) {
                            cx = transData.ctrlX;
                            cy = transData.ctrlY;
                        }

                        function getRectangleIntersection(rectEl, fromX, fromY, toX, toY) {
                            const w = rectEl.offsetWidth / 2; const h = rectEl.offsetHeight / 2;
                            const rectCenterX = rectEl.offsetLeft + w; const rectCenterY = rectEl.offsetTop + h;
                            const dx = toX - fromX; const dy = toY - fromY;
                            if (dx === 0 && dy === 0) return { x: rectCenterX, y: rectCenterY };
                            const absX = Math.abs(w / dx); const absY = Math.abs(h / dy);
                            return { x: rectCenterX + dx * Math.min(absX, absY), y: rectCenterY + dy * Math.min(absX, absY) };
                        }

                        const edgeX1 = isInitialLink ? srcCenterX : getRectangleIntersection(srcEl, srcCenterX, srcCenterY, cx, cy).x; 
                        const edgeY1 = isInitialLink ? srcCenterY : getRectangleIntersection(srcEl, srcCenterX, srcCenterY, cx, cy).y;
                        const edgeX2 = getRectangleIntersection(dstEl, dstCenterX, dstCenterY, cx, cy).x; const edgeY2 = getRectangleIntersection(dstEl, dstCenterX, dstCenterY, cx, cy).y;

                        const apexX = 0.25 * edgeX1 + 0.5 * cx + 0.25 * edgeX2;
                        const apexY = 0.25 * edgeY1 + 0.5 * cy + 0.25 * edgeY2;

                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        path.setAttribute('d', \`M \${edgeX1} \${edgeY1} Q \${cx} \${cy} \${edgeX2} \${edgeY2}\`);
                        path.setAttribute('stroke', isInitialLink ? 'var(--vscode-charts-blue, #007acc)' : 'var(--vscode-button-background)');
                        path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none'); path.setAttribute('marker-end', 'url(#arrow)');
                        path.className.baseVal = "transition-clickable-path";
                        
                        path.addEventListener('click', (e) => {
                            e.stopPropagation(); activeDelSourceId = sourceId; activeDelTransIndex = transIdx;
                            document.getElementById('delete-trans-text').innerText = \`Remove transition triggered by: \${eventName}?\`;
                            deleteTransModal.style.display = 'flex';
                        });
                        linksGroup.appendChild(path);

                        const handleCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                        handleCircle.setAttribute('cx', apexX);
                        handleCircle.setAttribute('cy', apexY);
                        handleCircle.setAttribute('r', '6');
                        handleCircle.setAttribute('fill', 'var(--vscode-textLink-foreground, #007acc)');
                        handleCircle.setAttribute('style', 'cursor: move; pointer-events: auto; opacity: 0; transition: opacity 0.2s;');
                        
                        path.addEventListener('mouseenter', () => handleCircle.style.opacity = '1');
                        handleCircle.addEventListener('mouseenter', () => handleCircle.style.opacity = '1');
                        path.addEventListener('mouseleave', () => handleCircle.style.opacity = '0');
                        handleCircle.addEventListener('mouseleave', () => handleCircle.style.opacity = '0');

                        handleCircle.addEventListener('mousedown', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            let startMouseX = e.clientX;
                            let startMouseY = e.clientY;
                            const initCtrlX = cx;
                            const initCtrlY = cy;

                            function onHandleMove(moveEvent) {
                                const deltaX = (moveEvent.clientX - startMouseX) / scale;
                                const deltaY = (moveEvent.clientY - startMouseY) / scale;
                                
                                transData.ctrlX = initCtrlX + deltaX;
                                transData.ctrlY = initCtrlY + deltaY;
                                
                                const liveX1 = isInitialLink ? srcCenterX : getRectangleIntersection(srcEl, srcCenterX, srcCenterY, transData.ctrlX, transData.ctrlY).x;
                                const liveY1 = isInitialLink ? srcCenterY : getRectangleIntersection(srcEl, srcCenterX, srcCenterY, transData.ctrlX, transData.ctrlY).y;
                                const liveX2 = getRectangleIntersection(dstEl, dstCenterX, dstCenterY, transData.ctrlX, transData.ctrlY).x;
                                const liveY2 = getRectangleIntersection(dstEl, dstCenterX, dstCenterY, transData.ctrlX, transData.ctrlY).y;
                                
                                const liveApexX = 0.25 * liveX1 + 0.5 * transData.ctrlX + 0.25 * liveX2;
                                const liveApexY = 0.25 * liveY1 + 0.5 * transData.ctrlY + 0.25 * liveY2;

                                handleCircle.setAttribute('cx', liveApexX);
                                handleCircle.setAttribute('cy', liveApexY);
                                text.setAttribute('x', liveApexX + 8);
                                text.setAttribute('y', liveApexY - 8);
                                
                                path.setAttribute('d', \`M \${liveX1} \${liveY1} Q \${transData.ctrlX} \${transData.ctrlY} \${liveX2} \${liveY2}\`);
                            }

                            function onHandleUp() {
                                window.removeEventListener('mousemove', onHandleMove);
                                window.removeEventListener('mouseup', onHandleUp);
                                commitHsmChange();
                            }

                            window.addEventListener('mousemove', onHandleMove);
                            window.addEventListener('mouseup', onHandleUp);
                        });
                        linksGroup.appendChild(handleCircle);

                        const labelText = guardName ? \`\${eventName} [\${guardName}]\` : eventName;
                        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                        text.setAttribute('x', apexX + 8); text.setAttribute('y', apexY - 8); text.setAttribute('class', 'transition-label'); text.textContent = labelText;
                        linksGroup.appendChild(text);
                    }

                    function setupRaggedClampPosition(mainState, deltaX, deltaY, index, el, allDescendants) {
                        let nextMainX = Math.max(0, mainState.x + deltaX);
                        let nextMainY = Math.max(0, mainState.y + deltaY);
                        const allowedDeltaX = nextMainX - mainState.x;
                        const allowedDeltaY = nextMainY - mainState.y;
                        
                        mainState.x = nextMainX;
                        mainState.y = nextMainY;
                        el.style.left = mainState.x + "px"; 
                        el.style.top = mainState.y + "px";
                        
                        allDescendants.forEach(descendant => {
                            descendant.x += allowedDeltaX;
                            descendant.y += allowedDeltaY;
                            const childEl = document.getElementById('node-' + descendant.id);
                            if (childEl) { 
                                childEl.style.left = descendant.x + "px"; 
                                childEl.style.top = descendant.y + "px"; 
                            }
                        });
                        updateAllTransitions();
                    }

                    function setupDragAndResize(el, index) {
                        const handle = el.querySelector('.resize-handle');
                        let initialWidth = 0, initialHeight = 0, initialX = 0, initialY = 0;

                        handle.addEventListener('mousedown', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            initialWidth = el.offsetWidth; initialHeight = el.offsetHeight; initialX = e.clientX; initialY = e.clientY;
                            function onResizeMove(moveEvent) {
                                const deltaW = (moveEvent.clientX - initialX) / scale; const deltaH = (moveEvent.clientY - initialY) / scale;
                                const nextWidth = Math.max(140, initialWidth + deltaW); const nextHeight = Math.max(80, initialHeight + deltaH);
                                el.style.width = nextWidth + 'px'; el.style.height = nextHeight + 'px';
                                currentHsmData.states[index].width = nextWidth; currentHsmData.states[index].height = nextHeight; updateAllTransitions();
                            }
                            function onResizeUp() { window.removeEventListener('mousemove', onResizeMove); window.removeEventListener('mouseup', onResizeUp); commitHsmChange(); }
                            window.addEventListener('mousemove', onResizeMove); window.addEventListener('mouseup', onResizeUp);
                        });

                        el.onmousedown = function(e) {
                            if(e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.classList.contains('resize-handle') || e.target.classList.contains('initial-pseudostate-dot') || isLinkingMode) return;
                            e.preventDefault(); e.stopPropagation(); initialX = e.clientX; initialY = e.clientY;
                            const mainState = currentHsmData.states[index];
                            
                            function getAllDescendants(parentId) {
                                let descendants = []; const immediateChildren = currentHsmData.states.filter(s => s.parent === parentId);
                                descendants = descendants.concat(immediateChildren);
                                immediateChildren.forEach(child => { descendants = descendants.concat(getAllDescendants(child.id)); });
                                return descendants;
                            }
                            const allDescendants = getAllDescendants(mainState.id);

                            function elementDrag(moveEvent) {
                                moveEvent.preventDefault();
                                const deltaX = (moveEvent.clientX - initialX) / scale;
                                const deltaY = (moveEvent.clientY - initialY) / scale;
                                initialX = moveEvent.clientX; initialY = moveEvent.clientY;
                                setupRaggedClampPosition(mainState, deltaX, deltaY, index, el, allDescendants);
                            }
                            function closeDragElement() { window.removeEventListener('mousemove', elementDrag); window.removeEventListener('mouseup', closeDragElement); commitHsmChange(); }
                            window.addEventListener('mousemove', elementDrag); window.addEventListener('mouseup', closeDragElement);
                        };
                    }

                    document.getElementById('menu-add-event').addEventListener('click', () => {
                        document.getElementById('input-signal').value = ''; document.getElementById('input-action').value = '';
                        document.getElementById('hint-event-signal').style.display = 'none';
                        document.getElementById('hint-event-action').style.display = 'none';
                        eventModal.style.display = 'flex';
                    });
                    document.getElementById('btn-cancel-event').addEventListener('click', () => eventModal.style.display = 'none');
                    document.getElementById('btn-cancel-substate').addEventListener('click', () => substateModal.style.display = 'none');

                    document.getElementById('btn-submit-event').addEventListener('click', () => {
                        const signal = document.getElementById('input-signal').value.trim();
                        const actionInputText = document.getElementById('input-action').value.trim();
                        if (!signal) return;

                        const cleanActionName = actionInputText.replace('()', '').trim();

                        if (!currentHsmData.signals.includes(signal)) currentHsmData.signals.push(signal);
                        if (cleanActionName && !currentHsmData.actions.includes(cleanActionName)) currentHsmData.actions.push(cleanActionName);

                        const state = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        if (state) {
                            if (!state.local_events) state.local_events = [];
                            
                            const eventRowString = actionInputText ? "· " + signal + " / " + actionInputText : "· " + signal;
                            if (!state.local_events.includes(eventRowString)) {
                                state.local_events.push(eventRowString);
                            }
                            
                            commitHsmChange();
                            renderHsmWorkspace();
                            renderSidebarRegistry();
                        }
                        eventModal.style.display = 'none';
                    });

                    function commitHsmChange() {
                        vscode.postMessage({
                            type: 'documentEdit',
                            jsonText: JSON.stringify(currentHsmData, null, 2)
                        });
                    }

                    const rootstateModal = document.getElementById('rootstate-modal');

                    document.getElementById('add-state-btn').addEventListener('click', () => {
                        document.getElementById('input-rootname').value = '';
                        document.getElementById('error-rootstate').style.display = 'none';
                        
                        const submitBtn = document.getElementById('btn-submit-rootstate');
                        submitBtn.disabled = false;
                        submitBtn.style.opacity = '1';
                        submitBtn.style.cursor = 'pointer';
                        
                        rootstateModal.style.display = 'flex';
                    });

                    document.getElementById('menu-rename-state').addEventListener('click', () => {
                        const targetState = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        if (!targetState) return;
                        
                        document.getElementById('input-rename-name').value = targetState.name;
                        document.getElementById('error-rename').style.display = 'none';
                        
                        const submitBtn = document.getElementById('btn-submit-rename');
                        submitBtn.disabled = false;
                        submitBtn.style.opacity = '1';
                        submitBtn.style.cursor = 'pointer';
                        
                        renameModal.style.display = 'flex';
                    });

                    document.getElementById('btn-cancel-rootstate').addEventListener('click', () => {
                        rootstateModal.style.display = 'none';
                    });

                    document.getElementById('btn-cancel-rename').addEventListener('click', () => {
                        renameModal.style.display = 'none';
                    });

                    document.getElementById('btn-submit-rename').addEventListener('click', () => {
                        const rawName = document.getElementById('input-rename-name').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                        const errorBanner = document.getElementById('error-rename');
                        if (!rawName) return;

                        let nameExists = false;
                        document.querySelectorAll('.hsm-state-node').forEach(node => {
                            if (node.id === 'node-' + activeMenuStateId) return;
                            const span = node.querySelector('.hsm-state-header span');
                            if (span && span.innerText.trim().toUpperCase() === rawName) {
                                nameExists = true;
                            }
                        });

                        if (nameExists) {
                            errorBanner.style.display = 'block';
                            return;
                        }

                        const state = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        if (state) {
                            state.name = rawName;
                            state.entry = "entry_" + rawName;
                            state.exit = "exit_" + rawName;
                            commitHsmChange();
                            renderHsmWorkspace();
                        }
                        renameModal.style.display = 'none';
                    });

                    document.getElementById('btn-submit-rootstate').addEventListener('click', () => {
                        const rawName = document.getElementById('input-rootname').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                        const errorBanner = document.getElementById('error-rootstate');
                        if (!rawName) return;

                        let nameExists = false;
                        document.querySelectorAll('.hsm-state-header span').forEach(span => {
                            if (span.innerText.trim().toUpperCase() === rawName) {
                                nameExists = true;
                            }
                        });
                        
                        if (nameExists) {
                            errorBanner.style.display = 'block';
                            return;
                        }

                        const id = "STATE_" + Date.now().toString().slice(-4);
                        currentHsmData.states.push({ 
                            id: id, name: rawName, x: 150, y: 150, width: 180, height: 90,
                            entry: "entry_" + rawName, exit: "exit_" + rawName
                        });
                        
                        commitHsmChange();
                        renderHsmWorkspace();
                        rootstateModal.style.display = 'none';
                    });

                    document.getElementById('btn-submit-substate').addEventListener('click', () => {
                        const rawInput = document.getElementById('input-subname').value;
                        if (!rawInput) return;
                        
                        const subNames = rawInput.split(',')
                            .map(name => name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'))
                            .filter(name => name.length > 0);
                            
                        if (subNames.length === 0) return;

                        let duplicateFound = false;
                        subNames.forEach(subName => {
                            if (isStateNameDuplicate(subName)) {
                                duplicateFound = true;
                            }
                        });

                        if (duplicateFound) {
                            alert("❌ One or more sub-state names are already taken! All names must be unique.");
                            return;
                        }

                        const parentState = currentHsmData.states.find(s => s.id === activeMenuStateId);
                        if (parentState) {
                            subNames.forEach((subName, index) => {
                                const subId = "STATE_" + (Date.now() + index).toString().slice(-4);
                                
                                currentHsmData.states.push({ 
                                    id: subId, 
                                    name: subName, 
                                    parent: parentState.id, 
                                    x: parentState.x + 40 + (index * 25), 
                                    y: parentState.y + 70 + (index * 25), 
                                    width: 180, 
                                    height: 90,
                                    entry: "entry_" + subName, 
                                    exit: "exit_" + subName
                                });
                            });
                            
                            const actualEl = document.getElementById('node-' + parentState.id);
                            const widthBump = subNames.length > 2 ? (subNames.length * 20) : 0;
                            parentState.width = actualEl ? Math.max(320 + widthBump, actualEl.offsetWidth) : (parentState.width || 320);
                            parentState.height = actualEl ? Math.max(240 + widthBump, actualEl.offsetHeight) : (parentState.height || 240);
                            
                            commitHsmChange();
                            renderHsmWorkspace();
                        }
                        substateModal.style.display = 'none';
                    });

                    function isStateNameDuplicate(nameToCheck, excludeStateId = null) {
                        const sanitized = nameToCheck.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                        if (!sanitized) return false;
                        return currentHsmData.states.some(s => 
                            s.id !== excludeStateId && 
                            s.name.toUpperCase() === sanitized
                        );
                    }

                    document.getElementById('input-rootname').addEventListener('input', (e) => {
                        const inputVal = e.target.value;
                        const errorBanner = document.getElementById('error-rootstate');
                        const submitBtn = document.getElementById('btn-submit-rootstate');
                        
                        if (isStateNameDuplicate(inputVal)) {
                            errorBanner.style.display = 'block';
                            submitBtn.disabled = true;
                            submitBtn.style.opacity = '0.5';
                            submitBtn.style.cursor = 'not-allowed';
                        } else {
                            errorBanner.style.display = 'none';
                            submitBtn.disabled = false;
                            submitBtn.style.opacity = '1';
                            submitBtn.style.cursor = 'pointer';
                        }
                    });

                    document.getElementById('input-rename-name').addEventListener('input', (e) => {
                        const inputVal = e.target.value;
                        const errorBanner = document.getElementById('error-rename');
                        const submitBtn = document.getElementById('btn-submit-rename');
                        
                        if (isStateNameDuplicate(inputVal, activeMenuStateId)) {
                            errorBanner.style.display = 'block';
                            submitBtn.disabled = true;
                            submitBtn.style.opacity = '0.5';
                            submitBtn.style.cursor = 'not-allowed';
                        } else {
                            errorBanner.style.display = 'none';
                            submitBtn.disabled = false;
                            submitBtn.style.opacity = '1';
                            submitBtn.style.cursor = 'pointer';
                        }
                    });

                    document.getElementById('input-subname').addEventListener('input', (e) => {
                        const inputVal = e.target.value;
                        const errorBanner = document.getElementById('error-substate');
                        const submitBtn = document.getElementById('btn-submit-substate');
                        
                        if (isStateNameDuplicate(inputVal)) {
                            errorBanner.style.display = 'block';
                            submitBtn.disabled = true;
                            submitBtn.style.opacity = '0.5';
                            submitBtn.style.cursor = 'not-allowed';
                        } else {
                            errorBanner.style.display = 'none';
                            submitBtn.disabled = false;
                            submitBtn.style.opacity = '1';
                            submitBtn.style.cursor = 'pointer';
                        }
                    });

                    document.getElementById('menu-add-substate').addEventListener('click', () => {
                        document.getElementById('input-subname').value = '';
                        document.getElementById('error-substate').style.display = 'none';
                        
                        const submitBtn = document.getElementById('btn-submit-substate');
                        submitBtn.disabled = false;
                        submitBtn.style.opacity = '1';
                        submitBtn.style.cursor = 'pointer';
                        
                        contextMenu.style.display = 'none';
                        substateModal.style.display = 'flex';
                    });

                    document.getElementById('export-cpp-btn').addEventListener('click', () => {
                        vscode.postMessage({
                            type: 'exportCppBlueprint'
                        });
                    });

                    renderHsmWorkspace();
                    renderSidebarRegistry();

                    vscode.postMessage({ type: 'ready' });
                    applyTransformMatrix();
                </script>
            </body>
            </html>
        `;
    }
}