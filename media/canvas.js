// ==========================================================================
// FaCanvas: the diagram canvas shared by the FreeActors editors (state machines, applications).
// Knows boxes, nesting and links, nothing about states or components:
//   - view: pan (drag the background), zoom (wheel, around the cursor), reset
//   - boxes: drag (with everything nested inside), resize
//   - links: curved arrows between boxes, clipped at the box edges, with a draggable control point
//   - linking: a rubber band from a box to the cursor, highlighting the box under it
// Each editor owns its model and its UI (menus, dialogs) and calls into this module.
// ==========================================================================
'use strict';

const FaCanvas = (() => {
    const SVG = 'http://www.w3.org/2000/svg';

    // options: container, viewport, linksGroup, rubberBand (svg path), zoomReadout,
    //          panBlocked() -> true while the editor is linking, onCommit() -> the model changed (save it)
    function create(options) {
        const { container, viewport, linksGroup, rubberBand, zoomReadout } = options;
        const panBlocked = options.panBlocked || (() => false);
        const onCommit = options.onCommit || (() => {});
        const view = { scale: 1.0, panX: 0, panY: 0 };

        // ---- View -------------------------------------------------------------------------------------------

        function applyTransform() {
            viewport.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.scale})`;
            container.style.backgroundSize = `${20 * view.scale}px ${20 * view.scale}px`;
            container.style.backgroundPosition = `${view.panX}px ${view.panY}px`;
            if (zoomReadout) zoomReadout.innerText = `Zoom: ${Math.round(view.scale * 100)}%`;
        }

        function resetView() {
            view.scale = 1.0; view.panX = 0; view.panY = 0;
            applyTransform();
        }

        // Screen position -> canvas position
        function toCanvas(clientX, clientY) {
            const rect = container.getBoundingClientRect();
            return { x: (clientX - rect.left - view.panX) / view.scale, y: (clientY - rect.top - view.panY) / view.scale };
        }

        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const zoomIntensity = 0.05;
            const rect = container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left; const mouseY = e.clientY - rect.top;
            const viewportMouseX = (mouseX - view.panX) / view.scale; const viewportMouseY = (mouseY - view.panY) / view.scale;
            const delta = e.deltaY < 0 ? 1 : -1;
            const nextScale = Math.min(Math.max(0.3, view.scale + delta * zoomIntensity), 2.5);
            view.panX = mouseX - viewportMouseX * nextScale; view.panY = mouseY - viewportMouseY * nextScale;
            view.scale = nextScale;
            applyTransform();
        });

        let isPanning = false; let startPanX = 0; let startPanY = 0;
        container.addEventListener('mousedown', (e) => {
            if (e.target !== container && e.target.id !== 'workspace-viewport' && e.target.id !== 'svg-layer') return;
            if (panBlocked()) return;
            isPanning = true; startPanX = e.clientX - view.panX; startPanY = e.clientY - view.panY;
        });
        window.addEventListener('mousemove', (e) => {
            if (!isPanning) return; view.panX = e.clientX - startPanX; view.panY = e.clientY - startPanY; applyTransform();
        });
        window.addEventListener('mouseup', () => { isPanning = false; });

        // ---- Geometry ---------------------------------------------------------------------------------------

        // Where the line from the box's center towards (toX, toY) leaves the box
        function edgePoint(rectEl, fromX, fromY, toX, toY) {
            const w = rectEl.offsetWidth / 2; const h = rectEl.offsetHeight / 2;
            const rectCenterX = rectEl.offsetLeft + w; const rectCenterY = rectEl.offsetTop + h;
            const dx = toX - fromX; const dy = toY - fromY;
            if (dx === 0 && dy === 0) return { x: rectCenterX, y: rectCenterY };
            const absX = Math.abs(w / dx); const absY = Math.abs(h / dy);
            return { x: rectCenterX + dx * Math.min(absX, absY), y: rectCenterY + dy * Math.min(absX, absY) };
        }

        // Curvature for each link, so that several links between the same two boxes fan out instead of
        // overlapping. links: [{ from, to }] (box ids) -> [curveness]
        function fanOut(links) {
            const linkCounts = {};
            return links.map(({ from, to }) => {
                const idArray = [from, to].sort();
                const pairKey = `${idArray[0]}<->${idArray[1]}`;
                if (!linkCounts[pairKey]) linkCounts[pairKey] = 0;
                linkCounts[pairKey]++; const index = linkCounts[pairKey];
                let baseCurve = 35; if (index > 1) baseCurve = 35 + (Math.floor(index / 2) * 30);
                let finalCurveness = from === idArray[0] ? baseCurve : -baseCurve;
                if (index > 2 && index % 2 === 0) finalCurveness = -finalCurveness;
                return finalCurveness;
            });
        }

        // ---- Links ------------------------------------------------------------------------------------------

        // A curved arrow from srcEl to dstEl. link:
        //   srcEl, dstEl     the boxes
        //   start            optional fixed start point {x, y} (e.g. a pseudo-state dot); else the source's edge
        //   curveness        bend when the link has no saved control point
        //   data             the model object; its ctrlX/ctrlY keep a control point the user dragged
        //   label, stroke    text near the curve's apex; line color
        //   onClick          click on the line
        function drawLink(link) {
            const { srcEl, dstEl, start, curveness, data, label, stroke, onClick } = link;
            if (!srcEl || !dstEl) return;
            const srcCenterX = start ? start.x : srcEl.offsetLeft + (srcEl.offsetWidth / 2);
            const srcCenterY = start ? start.y : srcEl.offsetTop + (srcEl.offsetHeight / 2);
            const dstCenterX = dstEl.offsetLeft + (dstEl.offsetWidth / 2); const dstCenterY = dstEl.offsetTop + (dstEl.offsetHeight / 2);
            const mx = (srcCenterX + dstCenterX) / 2; const my = (srcCenterY + dstCenterY) / 2;
            const dx = dstCenterX - srcCenterX; const dy = dstCenterY - srcCenterY; const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            let cx = mx - (dy / distance) * curveness;
            let cy = my + (dx / distance) * curveness;
            if (data.ctrlX !== undefined && data.ctrlY !== undefined) {
                cx = data.ctrlX;
                cy = data.ctrlY;
            }

            const ends = (ctrlX, ctrlY) => {
                const a = start ? { x: srcCenterX, y: srcCenterY } : edgePoint(srcEl, srcCenterX, srcCenterY, ctrlX, ctrlY);
                const b = edgePoint(dstEl, dstCenterX, dstCenterY, ctrlX, ctrlY);
                return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
            };
            const e = ends(cx, cy);
            const apexX = 0.25 * e.x1 + 0.5 * cx + 0.25 * e.x2;
            const apexY = 0.25 * e.y1 + 0.5 * cy + 0.25 * e.y2;

            const path = document.createElementNS(SVG, 'path');
            path.setAttribute('d', `M ${e.x1} ${e.y1} Q ${cx} ${cy} ${e.x2} ${e.y2}`);
            path.setAttribute('stroke', stroke);
            path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none'); path.setAttribute('marker-end', 'url(#arrow)');
            path.className.baseVal = "transition-clickable-path";
            if (onClick) {
                path.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
            }
            linksGroup.appendChild(path);

            const handleCircle = document.createElementNS(SVG, 'circle');
            handleCircle.setAttribute('cx', apexX);
            handleCircle.setAttribute('cy', apexY);
            handleCircle.setAttribute('r', '6');
            handleCircle.setAttribute('fill', 'var(--vscode-textLink-foreground, #007acc)');
            handleCircle.setAttribute('style', 'cursor: move; pointer-events: auto; opacity: 0; transition: opacity 0.2s;');
            path.addEventListener('mouseenter', () => handleCircle.style.opacity = '1');
            handleCircle.addEventListener('mouseenter', () => handleCircle.style.opacity = '1');
            path.addEventListener('mouseleave', () => handleCircle.style.opacity = '0');
            handleCircle.addEventListener('mouseleave', () => handleCircle.style.opacity = '0');

            const text = document.createElementNS(SVG, 'text');

            // Dragging the handle moves the control point; it is saved in the model (data.ctrlX/ctrlY)
            handleCircle.addEventListener('mousedown', (ev) => {
                ev.preventDefault(); ev.stopPropagation();
                const startMouseX = ev.clientX; const startMouseY = ev.clientY;
                const initCtrlX = cx; const initCtrlY = cy;
                function onHandleMove(moveEvent) {
                    data.ctrlX = initCtrlX + (moveEvent.clientX - startMouseX) / view.scale;
                    data.ctrlY = initCtrlY + (moveEvent.clientY - startMouseY) / view.scale;
                    const live = ends(data.ctrlX, data.ctrlY);
                    const liveApexX = 0.25 * live.x1 + 0.5 * data.ctrlX + 0.25 * live.x2;
                    const liveApexY = 0.25 * live.y1 + 0.5 * data.ctrlY + 0.25 * live.y2;
                    handleCircle.setAttribute('cx', liveApexX);
                    handleCircle.setAttribute('cy', liveApexY);
                    text.setAttribute('x', liveApexX + 8);
                    text.setAttribute('y', liveApexY - 8);
                    path.setAttribute('d', `M ${live.x1} ${live.y1} Q ${data.ctrlX} ${data.ctrlY} ${live.x2} ${live.y2}`);
                }
                function onHandleUp() {
                    window.removeEventListener('mousemove', onHandleMove);
                    window.removeEventListener('mouseup', onHandleUp);
                    onCommit();
                }
                window.addEventListener('mousemove', onHandleMove);
                window.addEventListener('mouseup', onHandleUp);
            });
            linksGroup.appendChild(handleCircle);

            text.setAttribute('x', apexX + 8); text.setAttribute('y', apexY - 8); text.setAttribute('class', 'transition-label'); text.textContent = label;
            linksGroup.appendChild(text);
        }

        // ---- Boxes ------------------------------------------------------------------------------------------

        // Drag and resize for a box. box: { el, item (model object with x, y, width, height),
        // descendants() -> model objects nested inside (moved along), elOf(item) -> element of a nested item,
        // skip(target) -> true for elements that must not start a drag, onMove() -> redraw links,
        // minWidth, minHeight }
        function attachDragResize(box) {
            const { el, item } = box;
            const handle = el.querySelector('.resize-handle');
            let initialWidth = 0, initialHeight = 0, initialX = 0, initialY = 0;

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault(); e.stopPropagation();
                initialWidth = el.offsetWidth; initialHeight = el.offsetHeight; initialX = e.clientX; initialY = e.clientY;
                function onResizeMove(moveEvent) {
                    const deltaW = (moveEvent.clientX - initialX) / view.scale; const deltaH = (moveEvent.clientY - initialY) / view.scale;
                    const nextWidth = Math.max(box.minWidth, initialWidth + deltaW); const nextHeight = Math.max(box.minHeight, initialHeight + deltaH);
                    el.style.width = nextWidth + 'px'; el.style.height = nextHeight + 'px';
                    item.width = nextWidth; item.height = nextHeight; box.onMove();
                }
                function onResizeUp() { window.removeEventListener('mousemove', onResizeMove); window.removeEventListener('mouseup', onResizeUp); onCommit(); }
                window.addEventListener('mousemove', onResizeMove); window.addEventListener('mouseup', onResizeUp);
            });

            el.onmousedown = function (e) {
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' ||
                    e.target.classList.contains('resize-handle') || box.skip(e.target)) return;
                e.preventDefault(); e.stopPropagation(); initialX = e.clientX; initialY = e.clientY;
                const nested = box.descendants();

                function elementDrag(moveEvent) {
                    moveEvent.preventDefault();
                    const deltaX = (moveEvent.clientX - initialX) / view.scale;
                    const deltaY = (moveEvent.clientY - initialY) / view.scale;
                    initialX = moveEvent.clientX; initialY = moveEvent.clientY;
                    // The box stays at x, y >= 0; everything inside moves by the same (clamped) amount
                    const nextX = Math.max(0, item.x + deltaX);
                    const nextY = Math.max(0, item.y + deltaY);
                    const allowedDeltaX = nextX - item.x;
                    const allowedDeltaY = nextY - item.y;
                    item.x = nextX; item.y = nextY;
                    el.style.left = item.x + "px";
                    el.style.top = item.y + "px";
                    nested.forEach(n => {
                        n.x += allowedDeltaX;
                        n.y += allowedDeltaY;
                        const childEl = box.elOf(n);
                        if (childEl) {
                            childEl.style.left = n.x + "px";
                            childEl.style.top = n.y + "px";
                        }
                    });
                    box.onMove();
                }
                function closeDragElement() { window.removeEventListener('mousemove', elementDrag); window.removeEventListener('mouseup', closeDragElement); onCommit(); }
                window.addEventListener('mousemove', elementDrag); window.addEventListener('mouseup', closeDragElement);
            };
        }

        // All items nested (at any depth) inside the item with the given id. items: [{ id, parent }]
        function descendantsOf(items, parentId) {
            let descendants = []; const immediateChildren = items.filter(s => s.parent === parentId);
            descendants = descendants.concat(immediateChildren);
            immediateChildren.forEach(child => { descendants = descendants.concat(descendantsOf(items, child.id)); });
            return descendants;
        }

        // ---- Linking: a rubber band from a box to the cursor -------------------------------------------------

        let rubber = null;          // { sourceEl, start() -> {x,y} | null, candidates() -> elements }
        let lastHovered = null;

        function onRubberBandMove(e) {
            if (!rubber) return;
            const srcEl = rubber.sourceEl();
            if (!srcEl) return;
            const mouse = toCanvas(e.clientX, e.clientY);
            let edgeX1, edgeY1;
            const fixed = rubber.start ? rubber.start(srcEl) : null;
            if (fixed) {
                edgeX1 = fixed.x; edgeY1 = fixed.y;
            } else {
                const w = srcEl.offsetWidth / 2;
                const h = srcEl.offsetHeight / 2;
                const srcCenterX = srcEl.offsetLeft + w;
                const srcCenterY = srcEl.offsetTop + h;
                const dx = mouse.x - srcCenterX;
                const dy = mouse.y - srcCenterY;
                edgeX1 = srcCenterX; edgeY1 = srcCenterY;
                if (dx !== 0 || dy !== 0) {
                    const t = Math.min(Math.abs(w / dx), Math.abs(h / dy));
                    edgeX1 = srcCenterX + dx * t;
                    edgeY1 = srcCenterY + dy * t;
                }
            }
            const mx = (edgeX1 + mouse.x) / 2;
            const my = (edgeY1 + mouse.y) / 2;
            const dxTot = mouse.x - edgeX1;
            const dyTot = mouse.y - edgeY1;
            const dist = Math.sqrt(dxTot * dxTot + dyTot * dyTot) || 1;
            const cx = mx - (dyTot / dist) * 30;
            const cy = my + (dxTot / dist) * 30;
            rubberBand.setAttribute('d', `M ${edgeX1} ${edgeY1} Q ${cx} ${cy} ${mouse.x} ${mouse.y}`);
            rubberBand.style.display = 'block';

            // The innermost box under the cursor (the smallest of those containing it): the one a click picks
            let found = null, foundArea = Infinity;
            for (const node of rubber.candidates()) {
                if (node === srcEl) continue;
                const r = node.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom &&
                    r.width * r.height < foundArea) {
                    found = node;
                    foundArea = r.width * r.height;
                }
            }
            if (found) {
                if (lastHovered !== found) {
                    if (lastHovered) lastHovered.classList.remove('link-target-candidate');
                    found.classList.add('link-target-candidate');
                    lastHovered = found;
                }
            } else if (lastHovered) {
                lastHovered.classList.remove('link-target-candidate');
                lastHovered = null;
            }
        }

        // linking: { sourceEl() -> the source box, start(srcEl) -> fixed start point or null,
        //            candidates() -> boxes that can be targets }
        function startLinking(linking) {
            rubber = linking;
            window.addEventListener('mousemove', onRubberBandMove);
        }

        // Hides the rubber band (the target was chosen, or linking was cancelled)
        function hideRubberBand() {
            rubberBand.style.display = 'none';
            window.removeEventListener('mousemove', onRubberBandMove);
        }

        function stopLinking(candidates) {
            hideRubberBand();
            rubber = null;
            if (lastHovered) {
                lastHovered.classList.remove('link-target-candidate');
                lastHovered = null;
            }
            candidates.forEach(n => n.classList.remove('link-target-candidate'));
        }

        return { view, applyTransform, resetView, toCanvas, edgePoint, fanOut, drawLink,
                 attachDragResize, descendantsOf, startLinking, hideRubberBand, stopLinking };
    }

    return { create };
})();
