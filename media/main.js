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

// The shared canvas (media/canvas.js): view, pan and zoom, links, dragging, the linking rubber band
const canvas = FaCanvas.create({
    container: canvasContainer, viewport, linksGroup, rubberBand: rubberBandPath, zoomReadout,
    panBlocked: () => isLinkingMode,
    onCommit: () => commitHsmChange(),
});
function applyTransformMatrix() { canvas.applyTransform(); }
document.getElementById('reset-view-btn').addEventListener('click', () => canvas.resetView());

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
    
    canvas.hideRubberBand();
    
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
        currentHsmData.actions.forEach(act => { 
            const cleanAct = act.replace('()', '').trim().toUpperCase();
            actionRefs[cleanAct] = 0; 
        });
    }

    if (currentHsmData.states) {
        currentHsmData.states.forEach(s => {
            // 1. Check Entry Actions
            if (s.entry) {
                const entryKey = s.entry.replace('()', '').trim().toUpperCase();
                if (entryKey in actionRefs) actionRefs[entryKey]++;
            }

            // 2. Check Exit Actions
            if (s.exit) {
                const exitKey = s.exit.replace('()', '').trim().toUpperCase();
                if (exitKey in actionRefs) actionRefs[exitKey]++;
            }

            // 3. Check Local Handled Events (Internal Reactions)
            if (s.local_events && Array.isArray(s.local_events)) {
                s.local_events.forEach(ev => {
                    if (typeof ev === 'string') {
                        const cleanEv = ev.replace('·', '').trim().toUpperCase();
                        if (cleanEv.includes('/')) {
                            const parts = cleanEv.split('/');
                            const sigPart = parts[0] ? parts[0].trim() : '';
                            const actPart = parts[1] ? parts[1].replace('()', '').split('(')[0].trim() : '';
                            
                            if (sigPart in signalRefs) signalRefs[sigPart]++;
                            if (actPart in actionRefs) actionRefs[actPart]++;
                        } else {
                            if (cleanEv in signalRefs) signalRefs[cleanEv]++;
                        }
                    }
                });
            }

            // 4. Check External Transitions
            if (s.transitions && Array.isArray(s.transitions)) {
                s.transitions.forEach(t => {
                    if (t.event) {
                        const cleanEv = t.event.trim().toUpperCase();
                        if (cleanEv.includes('/')) {
                            const parts = cleanEv.split('/');
                            const sigPart = parts[0] ? parts[0].trim() : '';
                            const actPart = parts[1] ? parts[1].replace('()', '').split('(')[0].trim() : '';

                            if (sigPart in signalRefs) signalRefs[sigPart]++;
                            if (actPart in actionRefs) actionRefs[actPart]++;
                        } else {
                            if (cleanEv in signalRefs) signalRefs[cleanEv]++;
                        }
                    }
                    if (t.guard) {
                        const guardKey = t.guard.trim().toUpperCase();
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
setupLiveValidation('input-action', 'hint-event-action', 'actions');
setupLiveValidation('input-trans-action', 'hint-trans-action', 'actions');

document.getElementById('input-signal').addEventListener('input', (e) => {
    const inputSignal = e.target.value.trim();
    const hintSignal = document.getElementById('hint-event-signal');
    const submitBtn = document.getElementById('btn-submit-event');
    const targetState = currentHsmData.states.find(s => s.id === activeMenuStateId);

    if (!inputSignal) {
        hintSignal.style.display = 'none';
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
        return;
    }

    const isDuplicateInState = targetState && targetState.local_events && targetState.local_events.some(ev => {
        const cleanEv = ev.replace('·', '').trim();
        const existingSignal = cleanEv.split('/')[0].trim();
        return existingSignal.toUpperCase() === inputSignal.toUpperCase();
    });

    if (isDuplicateInState) {
        hintSignal.innerText = `⚠️ '${inputSignal}' is already handled in ${targetState.name}`;
        hintSignal.style.color = 'var(--vscode-errorForeground, #f48771)';
        hintSignal.style.display = 'block';
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.style.cursor = 'not-allowed';
    } else {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';

        if (!currentHsmData.signals.includes(inputSignal)) {
            hintSignal.innerText = '⚠️ New Signal identifier. Will auto-register.';
            hintSignal.style.color = 'var(--vscode-textPreformat-foreground, #d7ba7d)';
            hintSignal.style.display = 'block';
        } else {
            hintSignal.style.display = 'none';
        }
    }
});

function setupLiveValidation(inputId, hintId, registryKey) {
    const input = document.getElementById(inputId);
    const hint = document.getElementById(hintId);
    input.addEventListener('input', () => {
        const val = input.value.trim();
        if (!val || val === 'Init_sig' || currentHsmData[registryKey].includes(val)) {
            hint.style.display = 'none';
        } else {
            hint.style.color = 'var(--vscode-textPreformat-foreground, #d7ba7d)';
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
                internalEventsHtml += `
                    <div class="local-event-row">
                        <span>⚡ ${ev}</span>
                        <button class="del-event-btn" data-state-index="${index}" data-event-index="${evIdx}" title="Delete handled event">×</button>
                    </div>
                `;
            });
        }

        node.innerHTML = `
            <div class="hsm-state-header">
                <div style="display:flex; align-items:center;">
                    <span>${state.name}</span>
                </div>
                <button class="hamburger-btn" data-state-id="${state.id}">☰</button>
            </div>
            <div class="hsm-state-actions">
                ${state.entry ? '<div>↳ 🟡 ' + state.entry + '</div>' : ''}
                ${state.exit ? '<div>↱ 🔴 ' + state.exit + '</div>' : ''}
                ${state.parent ? '<div style="font-size:0.8em; opacity:0.6; font-style:italic;">Parent: ' + state.parent + '</div>' : ''}
                ${internalEventsHtml}
            </div>
            <div class="resize-handle"></div>
        `;

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
                startStateLinking();
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
            btn.addEventListener('mousedown', (e) => e.stopPropagation());
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
            const opt = document.createElement('option'); opt.value = s.id; opt.innerText = `${s.name} (${s.id})`;
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
    startStateLinking();
});

// The rubber band starts at the state's edge, or at its initial pseudo-state dot
function initDotPoint(srcEl) {
    return { x: srcEl.offsetLeft + srcEl.offsetWidth - 40, y: srcEl.offsetTop + 16 };
}

function startStateLinking() {
    canvas.startLinking({
        sourceEl: () => document.getElementById('node-' + linkSourceStateId),
        start: (srcEl) => (isLinkingFromInitDot ? initDotPoint(srcEl) : null),
        candidates: () => document.querySelectorAll('.hsm-state-node'),
    });
}

function cancelLinkingMode() {
    isLinkingMode = false;
    isLinkingFromInitDot = false;
    linkSourceStateId = null;
    linkTargetStateId = null;
    linkingHint.style.display = 'none';
    canvasContainer.style.cursor = 'default';
    canvas.stopLinking(document.querySelectorAll('.hsm-state-node'));
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
    linksGroup.innerHTML = '';
    const links = [];
    currentHsmData.states.forEach(state => {
        (state.transitions || []).forEach((trans, transIdx) => links.push({ from: state.id, to: trans.target, state, trans, transIdx }));
    });
    const curves = canvas.fanOut(links);
    links.forEach(({ state, trans, transIdx }, i) => {
        const srcEl = document.getElementById('node-' + state.id);
        const isInitialLink = Boolean(trans.event && trans.event.startsWith('Init_sig'));
        const eventName = trans.event || '';
        canvas.drawLink({
            srcEl, dstEl: document.getElementById('node-' + trans.target),
            start: isInitialLink && srcEl ? initDotPoint(srcEl) : null,
            curveness: curves[i], data: trans,
            label: trans.guard ? `${eventName} [${trans.guard}]` : eventName,
            stroke: isInitialLink ? 'var(--vscode-charts-blue, #007acc)' : 'var(--vscode-button-background)',
            onClick: () => {
                activeDelSourceId = state.id; activeDelTransIndex = transIdx;
                document.getElementById('delete-trans-text').innerText = `Remove transition triggered by: ${eventName}?`;
                deleteTransModal.style.display = 'flex';
            },
        });
    });
}

function setupDragAndResize(el, index) {
    const state = currentHsmData.states[index];
    canvas.attachDragResize({
        el, item: state, minWidth: 140, minHeight: 80,
        descendants: () => canvas.descendantsOf(currentHsmData.states, state.id),
        elOf: (s) => document.getElementById('node-' + s.id),
        skip: (target) => target.classList.contains('initial-pseudostate-dot') || isLinkingMode,
        onMove: updateAllTransitions,
    });
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

    const targetState = currentHsmData.states.find(s => s.id === activeMenuStateId);
    if (!targetState) return;

    const isDuplicate = targetState.local_events && targetState.local_events.some(ev => {
        const cleanEv = ev.replace('·', '').trim();
        return cleanEv.split('/')[0].trim().toUpperCase() === signal.toUpperCase();
    });

    if (isDuplicate) return;

    const cleanActionName = actionInputText.replace('()', '').trim();

    if (!currentHsmData.signals.includes(signal)) currentHsmData.signals.push(signal);
    if (cleanActionName && !currentHsmData.actions.includes(cleanActionName)) {
        currentHsmData.actions.push(cleanActionName);
    }

    if (!targetState.local_events) targetState.local_events = [];
    
    const eventRowString = actionInputText ? "· " + signal + " / " + actionInputText : "· " + signal;
    targetState.local_events.push(eventRowString);
    
    commitHsmChange();
    renderHsmWorkspace();
    renderSidebarRegistry();
    
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