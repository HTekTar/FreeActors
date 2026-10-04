// ==========================================================================
// FreeActors application editor (*.app.json): components and how they talk (docs/design/app-diagram.md).
// The model is the JSON document; this page draws it with the shared canvas (canvas.js) and posts every
// change back to the extension, which owns the file.
// Messages from the extension: update { text, models: [{ file, name, signals }] }
// Messages to the extension:   ready, documentEdit { jsonText }, openFile { file }
// ==========================================================================
'use strict';

const vscode = acquireVsCodeApi();
const nodesLayer = document.getElementById('nodes-layer');
const linksGroup = document.getElementById('links-group');
const canvasContainer = document.getElementById('canvas-container');
const viewport = document.getElementById('workspace-viewport');
const contextMenu = document.getElementById('component-context-menu');
const linkingHint = document.getElementById('linking-hint');

const KINDS = {
    application: { label: 'Application', composite: true },
    subsystem:   { label: 'Subsystem', composite: true },
    actor:       { label: 'Actor' },
    periodic:    { label: 'Periodic' },
    interrupt:   { label: 'Interrupt' },
    spsc:        { label: 'SPSC service' },
    mpsc:        { label: 'MPSC service' },
    dma:         { label: 'DMA ring' },
};

// Default properties of a new component, by kind (the names become ActorTraits / TimeServiceTraits / module fields)
const DEFAULTS = {
    actor:     { priority: 2, queue: 8, stack: 128 },
    periodic:  { period_ms: 10, priority: 3, stack: 128 },
    interrupt: { irq: '', pri: 6 },
    spsc:      { item: 'uint16_t', size: 64, priority: 2, stack: 128 },
    mpsc:      { item: '', size: 64, priority: 2, stack: 128 },
    dma:       { element: 'uint8_t', size: 256, priority: 2, stack: 128 },
    subsystem: {},
};

// Editable properties per kind: [key, label, type]
const PROPERTIES = {
    actor:     [['priority', 'Priority', 'number'], ['queue', 'Queue length', 'number'], ['stack', 'Stack (words)', 'number']],
    periodic:  [['period_ms', 'Period (ms)', 'number'], ['priority', 'Priority', 'number'], ['stack', 'Stack (words)', 'number']],
    interrupt: [['irq', 'Interrupt (board Irq:: name)', 'text'], ['pri', 'NVIC priority (PRI)', 'number']],
    spsc:      [['item', 'Item type', 'text'], ['size', 'Buffer (items)', 'number'], ['priority', 'Priority', 'number'], ['stack', 'Stack (words)', 'number']],
    mpsc:      [['item', 'Item type', 'text'], ['size', 'Buffer (items)', 'number'], ['priority', 'Priority', 'number'], ['stack', 'Stack (words)', 'number']],
    dma:       [['element', 'Element type', 'text'], ['size', 'Buffer (elements)', 'number'], ['priority', 'Priority', 'number'], ['stack', 'Stack (words)', 'number']],
    subsystem: [],
    application: [],
};

let app = { name: 'App', board: {}, features: {}, settings: {}, components: [], connections: [] };
let models = [];                 // state machines in the folder: [{ file, name, signals }]
let problems = [];               // from the extension's checks: [{ severity, message, component?, connection? }]
let selectedId = null;
let menuComponentId = null;
let isLinkingMode = false;
let linkSourceId = null;
let linkTargetId = null;

const canvas = FaCanvas.create({
    container: canvasContainer, viewport, linksGroup,
    rubberBand: document.getElementById('rubber-band-path'),
    zoomReadout: document.getElementById('zoom-readout'),
    panBlocked: () => isLinkingMode,
    onCommit: () => commit(),
});
document.getElementById('reset-view-btn').addEventListener('click', () => canvas.resetView());
document.getElementById('export-app-btn').addEventListener('click', () => vscode.postMessage({ type: 'exportApplication' }));
document.getElementById('generate-board-btn').addEventListener('click', () => vscode.postMessage({ type: 'generateBoard' }));

// ---- Model ---------------------------------------------------------------------------------------------

const byId = (id) => app.components.find(c => c.id === id);
const modelOf = (component) => models.find(m => m.file === component.model);
const isComposite = (component) => Boolean(KINDS[component.kind] && KINDS[component.kind].composite);
// Where a component's code is: an actor's state machine, a module's file (created by Export Application)
const codeFileOf = (c) => c.kind === 'actor' ? c.model
    : ['periodic', 'interrupt', 'spsc', 'mpsc', 'dma'].includes(c.kind) ? `${String(c.name).toLowerCase()}_module.hpp` : undefined;

function commit() {
    vscode.postMessage({ type: 'documentEdit', jsonText: JSON.stringify(app, null, 2) });
}

function newId(prefix) {
    let n = app.components.length + app.connections.length + 1;
    while (byId(`${prefix}_${n}`) || app.connections.some(c => c.id === `${prefix}_${n}`)) n++;
    return `${prefix}_${n}`;
}

// ---- Rendering -----------------------------------------------------------------------------------------

function summaryOf(c) {
    const lines = [];
    if (c.kind === 'actor') {
        const m = modelOf(c);
        lines.push(c.model ? `📝 ${c.model}${m ? '' : ' (not found)'}` : '📝 no state machine');
        lines.push(`prio ${c.priority} · queue ${c.queue} · stack ${c.stack}`);
    } else if (c.kind === 'periodic') {
        lines.push(`⏱ every ${c.period_ms} ms · prio ${c.priority}`);
    } else if (c.kind === 'interrupt') {
        lines.push(`⚡ ${c.irq ? 'Irq::' + c.irq : 'interrupt not set'} · PRI ${c.pri}`);
    } else if (c.kind === 'spsc' || c.kind === 'mpsc') {
        lines.push(`${c.item || 'item type not set'} × ${c.size}`);
    } else if (c.kind === 'dma') {
        lines.push(`${c.element} × ${c.size}`);
    } else if (c.kind === 'application') {
        lines.push(app.board && app.board.type ? `🔌 ${app.board.type}` : '🔌 board not set');
    }
    return lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function render() {
    nodesLayer.innerHTML = ''; linksGroup.innerHTML = '';
    // Parents first, so nested components are drawn on top of the box containing them
    const depth = (c) => (c.parent && byId(c.parent) ? 1 + depth(byId(c.parent)) : 0);
    const ordered = app.components.slice().sort((a, b) => depth(a) - depth(b));

    ordered.forEach(c => {
        const el = document.createElement('div');
        el.id = 'node-' + c.id;
        const own = problems.filter(p => p.component === c.id);
        const worst = own.some(p => p.severity === 'error') ? 'error' : own.length > 0 ? 'warning' : '';
        el.className = `hsm-state-node fa-component kind-${c.kind}` + (isComposite(c) ? ' composite' : '') +
                       (c.id === selectedId ? ' selected' : '') + (worst ? ` has-${worst}` : '');
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
        el.style.width = (c.width || 200) + 'px'; el.style.height = (c.height || 90) + 'px';
        el.innerHTML = `
            <div class="hsm-state-header">
                <div class="fa-title"><span class="fa-name">${escapeHtml(c.name)}</span><span class="fa-kind">${KINDS[c.kind] ? KINDS[c.kind].label : c.kind}</span>${worst ? `<span class="fa-badge" title="${escapeHtml(own.map(p => p.message).join('\n'))}">${worst === 'error' ? '⛔' : '⚠️'}</span>` : ''}</div>
                <button class="hamburger-btn">☰</button>
            </div>
            <div class="fa-summary">${summaryOf(c)}</div>
            <div class="resize-handle"></div>`;

        const menuBtn = el.querySelector('.hamburger-btn');
        menuBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuComponentId = c.id;
            const rect = menuBtn.getBoundingClientRect();
            contextMenu.style.left = rect.left + 'px'; contextMenu.style.top = rect.bottom + 'px';
            document.getElementById('menu-add-inside').style.display = isComposite(c) ? 'block' : 'none';
            document.getElementById('menu-open-model').style.display = codeFileOf(c) ? 'block' : 'none';
            document.getElementById('menu-open-model').textContent = c.kind === 'actor' ? '📝 Open State Machine' : '📝 Open Code';
            document.getElementById('menu-delete').style.display = c.kind === 'application' ? 'none' : 'block';
            document.getElementById('menu-connect').style.display = isComposite(c) ? 'none' : 'block';
            contextMenu.style.display = 'flex';
        });
        el.addEventListener('mousedown', (e) => {
            if (isLinkingMode || e.target.tagName === 'BUTTON') return;
            select(c.id);
        });
        el.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const file = codeFileOf(c);
            if (file) vscode.postMessage({ type: 'openFile', file });
        });

        canvas.attachDragResize({
            el, item: c, minWidth: 160, minHeight: 70,
            descendants: () => canvas.descendantsOf(app.components, c.id),
            elOf: (n) => document.getElementById('node-' + n.id),
            skip: () => isLinkingMode,
            onMove: drawConnections,
        });
        nodesLayer.appendChild(el);
    });
    drawConnections();
    canvas.applyTransform();
    renderSidebar();
}

const CONNECTION_STROKE = {
    event: 'var(--vscode-button-background)',
    item: 'var(--vscode-charts-green, #89d185)',
    stream: 'var(--vscode-charts-purple, #b180d7)',
};

function connectionLabel(conn) {
    const mark = problems.some(p => p.connection === conn.id && p.severity === 'error') ? '⛔ '
               : problems.some(p => p.connection === conn.id) ? '⚠️ ' : '';
    if (conn.kind === 'event') return mark + ((conn.events || []).join(', ') || 'events');
    if (conn.kind === 'item') return mark + (conn.item ? `push ${conn.item}` : 'items');
    return mark + 'DMA stream';
}

function drawConnections() {
    linksGroup.innerHTML = '';
    const curves = canvas.fanOut(app.connections.map(c => ({ from: c.from, to: c.to })));
    app.connections.forEach((conn, i) => {
        canvas.drawLink({
            srcEl: document.getElementById('node-' + conn.from), dstEl: document.getElementById('node-' + conn.to),
            curveness: curves[i], data: conn, label: connectionLabel(conn),
            stroke: CONNECTION_STROKE[conn.kind] || CONNECTION_STROKE.event,
            onClick: () => confirmDelete(`Remove the connection "${connectionLabel(conn)}"?`, () => {
                app.connections = app.connections.filter(x => x !== conn);
                commit(); render();
            }),
        });
    });
}

// ---- Sidebar: application settings and the selected component's properties ------------------------------

function bindText(id, get, set) {
    const input = document.getElementById(id);
    input.value = get() || '';
    input.onchange = () => { set(input.value.trim()); commit(); render(); };
}

function bindCheck(id, key) {
    const input = document.getElementById(id);
    input.checked = Boolean(app.features && app.features[key]);
    input.onchange = () => { app.features = app.features || {}; app.features[key] = input.checked; commit(); };
}

function renderProblems() {
    const list = document.getElementById('problems-list');
    const errors = problems.filter(p => p.severity === 'error').length;
    document.getElementById('problems-title').textContent =
        problems.length === 0 ? 'Problems' : `Problems (${errors} error${errors === 1 ? '' : 's'}, ${problems.length - errors} warning${problems.length - errors === 1 ? '' : 's'})`;
    list.innerHTML = '';
    if (problems.length === 0) {
        list.innerHTML = '<div class="problems-ok">✓ No problems found</div>';
        return;
    }
    problems.forEach(p => {
        const item = document.createElement('div');
        item.className = `problem ${p.severity}`;
        item.textContent = p.message;
        const target = p.component || (p.connection && (app.connections.find(x => x.id === p.connection) || {}).from);
        if (target) item.addEventListener('click', () => select(target));
        list.appendChild(item);
    });
}

function renderSidebar() {
    renderProblems();
    app.board = app.board || {};
    bindText('app-name', () => app.name, v => {
        app.name = v || app.name;
        const root = app.components.find(c => c.kind === 'application');
        if (root) root.name = app.name;
    });
    bindText('app-board-type', () => app.board.type, v => { app.board.type = v; });
    bindText('app-board-header', () => app.board.header, v => { app.board.header = v; });
    bindCheck('feat-trace', 'trace');
    bindCheck('feat-commands', 'commands');
    bindCheck('feat-health', 'health');
    bindCheck('feat-debug', 'debug_commands');

    const props = document.getElementById('selection-props');
    const c = selectedId ? byId(selectedId) : null;
    if (!c) {
        document.getElementById('selection-title').innerText = 'Selection';
        props.innerHTML = '<div class="hint-text">Click a component to see and edit its properties.</div>';
        return;
    }
    document.getElementById('selection-title').innerText = `${KINDS[c.kind] ? KINDS[c.kind].label : c.kind}: ${c.name}`;
    props.innerHTML = '';
    const field = (label, value, type, onChange) => {
        const row = document.createElement('label'); row.className = 'prop-row';
        row.appendChild(document.createTextNode(label));
        const input = document.createElement('input'); input.type = type; input.value = value === undefined ? '' : value;
        input.onchange = () => { onChange(type === 'number' ? Number(input.value) : input.value.trim()); commit(); render(); };
        row.appendChild(input); props.appendChild(row);
    };
    if (c.kind !== 'application') field('Name', c.name, 'text', v => { if (v) c.name = v; });
    if (c.kind === 'actor') {
        const row = document.createElement('label'); row.className = 'prop-row';
        row.appendChild(document.createTextNode('State machine'));
        const select = document.createElement('select');
        select.innerHTML = '<option value="">(none)</option>' +
            models.map(m => `<option value="${escapeHtml(m.file)}">${escapeHtml(m.name)} (${escapeHtml(m.file)})</option>`).join('');
        select.value = c.model || '';
        select.onchange = () => { c.model = select.value; commit(); render(); };
        row.appendChild(select); props.appendChild(row);
    }
    (PROPERTIES[c.kind] || []).forEach(([key, label, type]) => field(label, c[key], type, v => { c[key] = v; }));
}

function select(id) {
    selectedId = id;
    document.querySelectorAll('.fa-component').forEach(n => n.classList.toggle('selected', n.id === 'node-' + id));
    renderSidebar();
}

// ---- Adding components ---------------------------------------------------------------------------------

const componentModal = document.getElementById('component-modal');

function openComponentModal(parentId) {
    const parentSelect = document.getElementById('input-parent');
    parentSelect.innerHTML = app.components.filter(isComposite)
        .map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${KINDS[c.kind].label})</option>`).join('');
    parentSelect.value = parentId || (app.components.find(c => c.kind === 'application') || {}).id || '';
    const modelSelect = document.getElementById('input-model');
    modelSelect.innerHTML = models.length === 0
        ? '<option value="">(no *.hsm.json in this folder)</option>'
        : models.map(m => `<option value="${escapeHtml(m.file)}">${escapeHtml(m.name)}</option>`).join('');
    document.getElementById('input-name').value = '';
    document.getElementById('hint-name').style.display = 'none';
    updateComponentModal();
    componentModal.style.display = 'flex';
}

function updateComponentModal() {
    const kind = document.getElementById('input-kind').value;
    document.getElementById('row-model').style.display = kind === 'actor' ? 'flex' : 'none';
    if (kind === 'actor') {
        const m = models.find(x => x.file === document.getElementById('input-model').value);
        if (m && !document.getElementById('input-name').value) document.getElementById('input-name').value = m.name;
    }
}
document.getElementById('input-kind').addEventListener('change', updateComponentModal);
document.getElementById('input-model').addEventListener('change', () => {
    const m = models.find(x => x.file === document.getElementById('input-model').value);
    if (m) document.getElementById('input-name').value = m.name;
});
document.getElementById('add-component-btn').addEventListener('click', () => openComponentModal(null));
document.getElementById('btn-cancel-component').addEventListener('click', () => { componentModal.style.display = 'none'; });
document.getElementById('btn-submit-component').addEventListener('click', () => {
    const kind = document.getElementById('input-kind').value;
    const name = document.getElementById('input-name').value.trim();
    const hint = document.getElementById('hint-name');
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        hint.innerText = 'A name is a C++ identifier: letters, digits and _ (not starting with a digit).';
        hint.style.display = 'block'; return;
    }
    if (app.components.some(c => c.name === name)) {
        hint.innerText = `There is already a component named ${name}.`;
        hint.style.display = 'block'; return;
    }
    const parent = byId(document.getElementById('input-parent').value);
    const siblings = app.components.filter(c => c.parent === (parent && parent.id)).length;
    const width = kind === 'subsystem' ? 520 : 250, height = kind === 'subsystem' ? 260 : 96;
    // Next free slot in a grid inside the parent, wrapping at its width
    const columns = Math.max(1, Math.floor(((parent ? parent.width : 1000) - 60) / (width + 20)));
    const component = Object.assign({
        id: newId('C'), kind, name, parent: parent ? parent.id : undefined,
        x: (parent ? parent.x : 40) + 30 + (siblings % columns) * (width + 20),
        y: (parent ? parent.y : 40) + 70 + Math.floor(siblings / columns) * (height + 30),
        width, height,
    }, JSON.parse(JSON.stringify(DEFAULTS[kind] || {})));
    if (kind === 'actor') component.model = document.getElementById('input-model').value;
    app.components.push(component);
    componentModal.style.display = 'none';
    selectedId = component.id;
    commit(); render();
});

// ---- Context menu --------------------------------------------------------------------------------------

document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
document.getElementById('menu-add-inside').addEventListener('click', () => openComponentModal(menuComponentId));
document.getElementById('menu-open-model').addEventListener('click', () => {
    const c = byId(menuComponentId);
    if (c && codeFileOf(c)) vscode.postMessage({ type: 'openFile', file: codeFileOf(c) });
});
document.getElementById('menu-delete').addEventListener('click', () => {
    const c = byId(menuComponentId);
    if (!c) return;
    const nested = canvas.descendantsOf(app.components, c.id);
    confirmDelete(nested.length > 0 ? `Delete ${c.name} and the ${nested.length} component(s) inside it?` : `Delete ${c.name}?`, () => {
        const gone = new Set([c.id, ...nested.map(n => n.id)]);
        app.components = app.components.filter(x => !gone.has(x.id));
        app.connections = app.connections.filter(x => !gone.has(x.from) && !gone.has(x.to));
        if (gone.has(selectedId)) selectedId = null;
        commit(); render();
    });
});

const confirmModal = document.getElementById('confirm-modal');
let confirmAction = null;
function confirmDelete(text, action) {
    document.getElementById('confirm-text').innerText = text;
    confirmAction = action;
    confirmModal.style.display = 'flex';
}
document.getElementById('btn-cancel-confirm').addEventListener('click', () => { confirmModal.style.display = 'none'; });
document.getElementById('btn-ok-confirm').addEventListener('click', () => {
    confirmModal.style.display = 'none';
    if (confirmAction) confirmAction();
});

// ---- Connecting: rubber band from the source, click the target ----------------------------------------

document.getElementById('menu-connect').addEventListener('click', () => {
    isLinkingMode = true;
    linkSourceId = menuComponentId;
    linkingHint.style.display = 'inline'; canvasContainer.style.cursor = 'crosshair';
    canvas.startLinking({
        sourceEl: () => document.getElementById('node-' + linkSourceId),
        start: () => null,
        candidates: () => document.querySelectorAll('.fa-component:not(.composite)'),
    });
});

function cancelLinking() {
    isLinkingMode = false; linkSourceId = null; linkTargetId = null;
    linkingHint.style.display = 'none'; canvasContainer.style.cursor = 'default';
    canvas.stopLinking(document.querySelectorAll('.fa-component'));
}
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isLinkingMode) cancelLinking(); });
canvasContainer.addEventListener('contextmenu', (e) => { if (isLinkingMode) { e.preventDefault(); cancelLinking(); } });

const connectionModal = document.getElementById('connection-modal');

canvasContainer.addEventListener('click', (e) => {
    if (!isLinkingMode) return;
    const targetEl = e.target.closest('.fa-component');
    if (!targetEl || targetEl.classList.contains('composite')) return;
    const targetId = targetEl.id.replace('node-', '');
    if (targetId === linkSourceId) return;
    e.stopPropagation();
    linkTargetId = targetId;
    canvas.hideRubberBand();
    openConnectionModal();
});

function openConnectionModal() {
    const src = byId(linkSourceId), dst = byId(linkTargetId);
    document.getElementById('connection-title').innerText = `${src.name} → ${dst.name}`;
    const kind = document.getElementById('input-conn-kind');
    kind.value = dst.kind === 'actor' ? 'event' : dst.kind === 'dma' ? 'stream' : 'item';
    document.getElementById('input-item').value = dst.item || dst.element || '';
    document.getElementById('input-events').value = '';
    const m = dst.kind === 'actor' ? modelOf(dst) : null;
    const signals = m ? m.signals : [];
    document.getElementById('events-checklist').innerHTML = signals.map(s =>
        `<label class="check-row"><input type="checkbox" value="${escapeHtml(s)}"> ${escapeHtml(s)}</label>`).join('');
    document.getElementById('row-events-text').style.display = signals.length > 0 ? 'none' : 'flex';
    updateConnectionModal();
    connectionModal.style.display = 'flex';
}

function updateConnectionModal() {
    const kind = document.getElementById('input-conn-kind').value;
    document.getElementById('row-events').style.display = kind === 'event' ? 'block' : 'none';
    document.getElementById('row-item').style.display = kind === 'item' ? 'flex' : 'none';
}
document.getElementById('input-conn-kind').addEventListener('change', updateConnectionModal);
document.getElementById('btn-cancel-connection').addEventListener('click', () => { connectionModal.style.display = 'none'; cancelLinking(); });
document.getElementById('btn-submit-connection').addEventListener('click', () => {
    const kind = document.getElementById('input-conn-kind').value;
    const conn = { id: newId('L'), from: linkSourceId, to: linkTargetId, kind };
    if (kind === 'event') {
        const checked = [...document.querySelectorAll('#events-checklist input:checked')].map(i => i.value);
        const typed = document.getElementById('input-events').value.split(',').map(s => s.trim()).filter(Boolean);
        conn.events = checked.length > 0 ? checked : typed;
    } else if (kind === 'item') {
        conn.item = document.getElementById('input-item').value.trim();
    }
    app.connections.push(conn);
    connectionModal.style.display = 'none';
    cancelLinking();
    commit(); render();
});

// ---- From the extension --------------------------------------------------------------------------------

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type !== 'update') return;
    try {
        const parsed = JSON.parse(message.text || '{}');
        app = Object.assign({ name: 'App', board: {}, features: {}, settings: {}, components: [], connections: [] }, parsed);
        models = message.models || [];
        problems = message.problems || [];
        if (selectedId && !byId(selectedId)) selectedId = null;
        render();
    } catch (e) {
        nodesLayer.innerHTML = '<div style="color:var(--vscode-errorForeground); padding:20px; pointer-events:auto;">' +
                               'This file is not a valid application model (JSON): ' + escapeHtml(e.message) + '</div>';
    }
});

vscode.postMessage({ type: 'ready' });
canvas.applyTransform();
