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
    viewport.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    canvasContainer.style.backgroundSize = `${20 * scale}px ${20 * scale}px`;
    canvasContainer.style.backgroundPosition = `${panX}px ${panY}px`;
    zoomReadout.innerText = `Zoom: ${Math.round(scale * 100)}%`;
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
    
    rubberBandPath.setAttribute('d', `M ${edgeX1} ${edgeY1} Q ${cx} ${cy} ${mouseX} ${mouseY}`);
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
                const pairKey = `${idArray[0]}<->${idArray[1]}`;
                if(!linkCounts[pairKey]) linkCounts[pairKey] = 0;
                linkCounts[pairKey]++; const index = linkCounts[pairKey];
                
                let baseCurve = 35; if (index > 1) baseCurve = 35 + (Math.floor(index / 2) * 30);
                let finalCurveness = state.id === idArray[0] ? baseCurve : -baseCurve;
                if (index > 2 && index % 2 === 0) finalCurveness = -finalCurveness;
                
                const isInitialLink = Boolean(trans.event && trans.event.startsWith('Init_sig'));
                drawTransitionLink(state.id, trans.target, trans.event || '', trans.guard, finalCurveness, transIdx, isInitialLink, trans);
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
    path.setAttribute('d', `M ${edgeX1} ${edgeY1} Q ${cx} ${cy} ${edgeX2} ${edgeY2}`);
    path.setAttribute('stroke', isInitialLink ? 'var(--vscode-charts-blue, #007acc)' : 'var(--vscode-button-background)');
    path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none'); path.setAttribute('marker-end', 'url(#arrow)');
    path.className.baseVal = "transition-clickable-path";
    
    path.addEventListener('click', (e) => {
        e.stopPropagation(); activeDelSourceId = sourceId; activeDelTransIndex = transIdx;
        document.getElementById('delete-trans-text').innerText = `Remove transition triggered by: ${eventName}?`;
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
            
            path.setAttribute('d', `M ${liveX1} ${liveY1} Q ${transData.ctrlX} ${transData.ctrlY} ${liveX2} ${liveY2}`);
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

    const labelText = guardName ? `${eventName} [${guardName}]` : eventName;
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