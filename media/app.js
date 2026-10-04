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
    interrupt: [['irq', 'Interrupt (board Irq:: name)', 'text'], ['pri', 'NVIC priority (PRI)', 'number'],
                ['commands', 'Feeds the PC commands (FA_TRACE_COMMANDS)', 'checkbox']],
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
document.getElementById('apply-flavour-btn').addEventListener('click', () => vscode.postMessage({ type: 'applyFlavour' }));

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
        lines.push(c.model ? `📝 ${c.model}${m ? '' : ' (not found)'}` : '📝 no state machine yet (double-click to create)');
        lines.push(`prio ${c.priority} · queue ${c.queue} · stack ${c.stack}`);
    } else if (c.kind === 'periodic') {
        lines.push(`⏱ every ${c.period_ms} ms · prio ${c.priority}`);
    } else if (c.kind === 'interrupt') {
        lines.push(`⚡ ${c.irq ? 'Irq::' + c.irq : 'interrupt not set'} · PRI ${c.pri}${c.commands ? ' · PC commands' : ''}`);
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
            const creates = c.kind === 'actor' && !c.model;
            document.getElementById('menu-open-model').style.display = codeFileOf(c) || creates ? 'block' : 'none';
            document.getElementById('menu-open-model').textContent =
                creates ? '✨ Create State Machine' : c.kind === 'actor' ? '📝 Open State Machine' : '📝 Open Code';
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
            openOrCreate(c);
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
    // The board's Target (its build decisions) and the application's settings
    const target = app.board.target || {};   // created when a field is first set
    const bindTarget = (id, key, kind) => {
        const input = document.getElementById(id);
        const value = target[key];
        input.value = value === undefined ? '' : kind === 'lines' ? value.join('\n') : value;
        input.onchange = () => {
            const v = input.value.trim();
            if (v === '') delete target[key];
            else target[key] = kind === 'number' ? Number(v) : kind === 'lines' ? v.split('\n').map(s => s.trim()).filter(Boolean) : v;
            if (Object.keys(target).length > 0) app.board.target = target; else delete app.board.target;
            commit(); renderSidebar();
        };
    };
    bindTarget('target-core', 'core'); bindTarget('target-prio-bits', 'nvic_prio_bits', 'number'); bindTarget('target-tick', 'tick_hz', 'number');
    bindTarget('target-linker', 'linker_script'); bindTarget('target-startup', 'startup');
    bindTarget('target-sources', 'sources', 'lines'); bindTarget('target-includes', 'includes', 'lines'); bindTarget('target-defines', 'defines', 'lines');
    bindTarget('target-freertos', 'freertos'); bindTarget('target-toolchain', 'toolchain'); bindTarget('target-flash', 'flash');
    bindTarget('target-flavour', 'flavour'); bindTarget('target-part', 'part'); bindTarget('target-sdk', 'sdk');
    bindTarget('target-flash-kb', 'flash_kb', 'number'); bindTarget('target-ram-kb', 'ram_kb', 'number');
    document.getElementById('flavour-fields').style.display = target.flavour ? 'flex' : 'none';
    document.getElementById('flavour-hint').textContent = target.flavour === 'stm32f4-hal'
        ? `Needs ST's repositories cmsis_core, cmsis_device_f4 and stm32f4xx_hal_driver (github.com/STMicroelectronics) in the SDK folder. ` +
          'Apply fills in the fields below and creates the linker script, the HAL configuration and the HAL tick glue if missing.' : '';
    if (target.core) document.getElementById('target-section').open = true;
    app.settings = app.settings || {};
    ['HealthCheckMs', 'WatchdogTimeoutMs', 'MaxTimers', 'MaxSyscallPriority'].forEach(key => {
        const input = document.getElementById('setting-' + key);
        input.value = app.settings[key] === undefined ? '' : app.settings[key];
        input.onchange = () => {
            if (input.value.trim() === '') delete app.settings[key]; else app.settings[key] = Number(input.value);
            commit();
        };
    });
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
        const input = document.createElement('input'); input.type = type;
        if (type === 'checkbox') {
            row.className = 'check-row'; input.checked = Boolean(value);
            input.onchange = () => { onChange(input.checked); commit(); render(); };
            row.insertBefore(input, row.firstChild); props.appendChild(row);
            return;
        }
        input.value = value === undefined ? '' : value;
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
        const m = modelOf(c);
        if (m) props.appendChild(signalList(c, m));
    }
    (PROPERTIES[c.kind] || []).forEach(([key, label, type]) => field(label, c[key], type, v => { c[key] = v; }));
}

// An actor's events (its state machine's signals), each renamed everywhere by the extension: in the state machine,
// in every application's connections, in the event struct (one source of truth)
function signalList(c, m) {
    const box = document.createElement('div');
    box.className = 'prop-row';
    box.appendChild(document.createTextNode('Events it receives (rename: ✎)'));
    const list = document.createElement('div'); list.className = 'signal-list';
    m.signals.forEach(s => {
        const item = document.createElement('div'); item.className = 'signal-item';
        const label = document.createElement('span'); label.textContent = s;
        const btn = document.createElement('button'); btn.textContent = '✎'; btn.title = `Rename ${s} everywhere`;
        btn.setAttribute('data-rename', s);
        btn.onclick = () => {
            const input = document.createElement('input'); input.type = 'text'; input.value = s;
            const done = (commitIt) => {
                const to = input.value.trim();
                if (commitIt && to && to !== s) {
                    if (!/^[A-Za-z_]\w*$/.test(to)) { input.style.borderColor = 'var(--vscode-errorForeground, #f48771)'; return; }
                    vscode.postMessage({ type: 'renameSignal', model: c.model, from: s, to });
                }
                renderSidebar();
            };
            input.onkeydown = (k) => { if (k.key === 'Enter') done(true); else if (k.key === 'Escape') done(false); };
            input.onchange = () => done(true);
            item.replaceChild(input, label); input.focus(); input.select();
        };
        item.appendChild(label); item.appendChild(btn); list.appendChild(item);
    });
    if (m.signals.length === 0) list.innerHTML = '<div class="hint-text">None yet: connect a component and type its events.</div>';
    box.appendChild(list);
    return box;
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
    // top-down: a new state machine, created by Export Application (or double-click) from the events sent to it
    modelSelect.innerHTML = '<option value="">(new: created from the diagram)</option>' +
        models.map(m => `<option value="${escapeHtml(m.file)}">${escapeHtml(m.name)} (${escapeHtml(m.file)})</option>`).join('');
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
// The first spot inside the parent (row by row, left to right) where a new box overlaps none of its siblings;
// below them all if none is free within the parent's width
const GAP = 20;
function freeSpotIn(parent, width, height) {
    const siblings = app.components.filter(c => c.parent === (parent ? parent.id : undefined) && c !== parent);
    const left = parent ? parent.x + 30 : 70, top = parent ? parent.y + 70 : 110;
    const right = Math.max(left + width, parent ? parent.x + parent.width - 30 : left + 1000);
    const free = (x, y) => siblings.every(s => x + width + GAP <= s.x || s.x + (s.width || 200) + GAP <= x ||
                                               y + height + GAP <= s.y || s.y + (s.height || 90) + GAP <= y);
    const bottom = siblings.reduce((b, s) => Math.max(b, s.y + (s.height || 90) + GAP), top);
    for (let y = top; y <= bottom; y += 10) {
        for (let x = left; x + width <= right; x += 10) {
            if (free(x, y)) return { x, y };
        }
    }
    return { x: left, y: bottom };
}

// Grows the parent (and its parents) so the box fits inside with a margin
function growToContain(parent, box) {
    for (let p = parent, inner = box; p; inner = p, p = p.parent ? byId(p.parent) : null) {
        p.width = Math.max(p.width || 200, inner.x + (inner.width || 200) + 30 - p.x);
        p.height = Math.max(p.height || 90, inner.y + (inner.height || 90) + 30 - p.y);
    }
}

document.getElementById('btn-submit-component').addEventListener('click', () => {
    const kind = document.getElementById('input-kind').value;
    const name = document.getElementById('input-name').value.trim();
    const hint = document.getElementById('hint-name');
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        hint.innerText = 'A name is a C++ identifier: letters, digits and _ (not starting with a digit).';
        hint.style.display = 'block'; return;
    }
    // the application itself may share a name (Timebomb in Timebomb.app.json): it is no C++ type (as in checkAppModel)
    if (app.components.some(c => c.name === name && c.kind !== 'application')) {
        hint.innerText = `There is already a component named ${name}.`;
        hint.style.display = 'block'; return;
    }
    const parent = byId(document.getElementById('input-parent').value);
    const width = kind === 'subsystem' ? 520 : 250, height = kind === 'subsystem' ? 260 : 96;
    const { x, y } = freeSpotIn(parent, width, height);
    const component = Object.assign({
        id: newId('C'), kind, name, parent: parent ? parent.id : undefined, x, y, width, height,
    }, JSON.parse(JSON.stringify(DEFAULTS[kind] || {})));
    growToContain(parent, component);
    if (kind === 'actor' && document.getElementById('input-model').value) component.model = document.getElementById('input-model').value;
    app.components.push(component);
    componentModal.style.display = 'none';
    selectedId = component.id;
    commit(); render();
});

// ---- Context menu --------------------------------------------------------------------------------------

document.addEventListener('click', () => { contextMenu.style.display = 'none'; });
document.getElementById('menu-add-inside').addEventListener('click', () => openComponentModal(menuComponentId));
document.getElementById('menu-open-model').addEventListener('click', () => { const c = byId(menuComponentId); if (c) openOrCreate(c); });

// Opens a component's code; an actor drawn without a state machine gets one (top-down): <Name>.hsm.json with the
// events sent to it, created and linked by the extension
function openOrCreate(c) {
    if (c.kind === 'actor' && !c.model) vscode.postMessage({ type: 'createStateMachine', id: c.id });
    else if (codeFileOf(c)) vscode.postMessage({ type: 'openFile', file: codeFileOf(c) });
}
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
    // new events can always be typed: they become signals of the receiving state machine
    document.getElementById('row-events-text').style.display = 'flex';
    document.getElementById('label-events-text').textContent = signals.length > 0 ? 'New events (comma-separated)' : 'Events (comma-separated)';
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
        conn.events = [...new Set(checked.concat(typed))];
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
