#!/usr/bin/env python3
# ==========================================================================
# Editor tests: the real web views (media/), loaded headless in Chrome with a model, driven by scripted mouse
# events; the page's final state is read back from the DOM (not from pixels, which differ between machines).
#   python3 tests/editor/editor_test.py <chrome> <out dir>
# Prints PASS/FAIL per check; exits non-zero on any failure.
# ==========================================================================
import json, os, subprocess, sys, html as htmllib, re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MEDIA = os.path.join(ROOT, 'media')
FIXTURES = os.path.join(ROOT, 'tests', 'fixtures')
chrome, out_dir = sys.argv[1], os.path.abspath(sys.argv[2])
os.makedirs(out_dir, exist_ok=True)
failures = 0

HELPERS = r'''
function fire(target, type, x, y) {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, view: window }));
}
function centerOf(el) { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
function node(id) { return document.getElementById('node-' + id); }
function drag(el, fromX, fromY, toX, toY) {
  fire(el, 'mousedown', fromX, fromY);
  for (let i = 1; i <= 5; i++) fire(window, 'mousemove', fromX + (toX - fromX) * i / 5, fromY + (toY - fromY) * i / 5);
  fire(window, 'mouseup', toX, toY);
}
function report(result) { document.body.setAttribute('data-result', JSON.stringify(result)); }
'''


def models_next_to(path):
    found = []
    folder = os.path.dirname(path)
    for f in sorted(os.listdir(folder)):
        if f.endswith('.hsm.json'):
            try:
                d = json.load(open(os.path.join(folder, f)))
                found.append({'file': f, 'name': d.get('name', ''),
                              'signals': [s if isinstance(s, str) else s.get('name') for s in d.get('signals', [])]})
            except Exception:
                pass
    return found


def problems_of(app_text, models):
    """The extension's checks (checkAppModel in out/extension.js) for an application model"""
    script = ("const M=require('module');const l=M._load;M._load=function(r,...a){return r==='vscode'?{}:l.call(this,r,...a)};"
              "const e=require(process.argv[1]);const i=JSON.parse(require('fs').readFileSync(0,'utf8'));"
              "process.stdout.write(JSON.stringify(e.checkAppModel(JSON.parse(i.app),i.models)));")
    out = subprocess.run(['node', '-e', script, os.path.join(ROOT, 'out', 'extension.js')],
                         input=json.dumps({'app': app_text, 'models': models}), capture_output=True, text=True, timeout=30)
    return json.loads(out.stdout or '[]')


def run(editor, model_path, scenario, name, models_dir=None):
    """Loads the editor with the model, runs the scenario, returns its report (dict) or None."""
    page = open(os.path.join(MEDIA, 'webview.html' if editor == 'hsm' else 'app.html')).read()
    files = {'{{styleUri}}': 'style.css', '{{appStyleUri}}': 'app.css', '{{canvasUri}}': 'canvas.js',
             '{{scriptUri}}': 'main.js' if editor == 'hsm' else 'app.js'}
    for key, f in files.items():
        page = page.replace(key, 'file://' + os.path.join(MEDIA, f))
    theme = open(os.path.join(os.path.dirname(__file__), 'theme.css')).read()
    model = open(model_path).read()
    models = models_next_to(os.path.join(models_dir, 'x') if models_dir else model_path)
    problems = problems_of(model, models) if editor == 'app' else []
    stub = ('<script>window.__edits = []; const MODEL = %s; const MODELS = %s; const PROBLEMS = %s;'
            'window.acquireVsCodeApi = () => ({ postMessage(m) {'
            ' if (m.type === "ready") setTimeout(() => window.postMessage({ type: "update", text: MODEL, models: MODELS, problems: PROBLEMS }, "*"), 0);'
            ' else window.__edits.push(m); }, getState() {}, setState() {} });</script>') % (json.dumps(model), json.dumps(models), json.dumps(problems))
    script = '<script>%s\nsetTimeout(() => { try { %s } catch (e) { report({ error: String(e) }); } }, 300);</script>' % (HELPERS, scenario)
    page = page.replace('</head>', '<style>' + theme + '</style></head>', 1)
    page = page.replace('<script src="file://', stub + '<script src="file://', 1)
    page = page.replace('</body>', script + '</body>', 1)
    page_path = os.path.join(out_dir, name + '.html')
    open(page_path, 'w').write(page)
    dom = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-sandbox', '--allow-file-access-from-files',
                          '--window-size=1400,900', '--virtual-time-budget=3000', '--dump-dom', 'file://' + page_path],
                         capture_output=True, text=True, timeout=60).stdout
    m = re.search(r'data-result="([^"]*)"', dom)
    return json.loads(htmllib.unescape(m.group(1))) if m else None


def check(name, ok, detail=''):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  editor: {name}{' — ' + detail if detail else ''}")
    if not ok:
        failures += 1


timebomb = os.path.join(FIXTURES, 'timebomb.hsm.json')
app = os.path.join(FIXTURES, 'timebomb.app.json')

# ---- State machine editor ---------------------------------------------------------------------------------

r = run('hsm', timebomb, '''
report({ states: document.querySelectorAll('.hsm-state-node').length,
         links: document.querySelectorAll('#links-group path').length,
         labels: [...document.querySelectorAll('.transition-label')].map(t => t.textContent) });''', 'hsm_render')
check('state machine editor draws the Timebomb model (7 states, transitions with labels and guards)',
      r is not None and r.get('states') == 7 and r.get('links', 0) >= 8 and 'Tick [TimeUp]' in r.get('labels', []), json.dumps(r))

r = run('hsm', timebomb, '''
const before = id => [node(id).offsetLeft, node(id).offsetTop];
const armed = before('STATE_2405'), wait = before('STATE_4409');
const el = node('STATE_2405'); const rect = el.getBoundingClientRect();
drag(el.querySelector('.hsm-state-header'), rect.left + 60, rect.top + 15, rect.left + 160, rect.top + 75);
const after = id => [node(id).offsetLeft, node(id).offsetTop];
const edit = window.__edits.filter(m => m.type === 'documentEdit').pop();
report({ armed: [after('STATE_2405')[0] - armed[0], after('STATE_2405')[1] - armed[1]],
         wait: [after('STATE_4409')[0] - wait[0], after('STATE_4409')[1] - wait[1]],
         saved: Boolean(edit) && JSON.parse(edit.jsonText).states.find(s => s.id === 'STATE_4409').x === after('STATE_4409')[0] });''', 'hsm_drag')
check('dragging a composite state moves the states inside it by the same amount, and saves the model',
      r is not None and r.get('armed') == [100, 60] and r.get('wait') == [100, 60] and r.get('saved') is True, json.dumps(r))

r = run('hsm', timebomb, '''
fire(node('STATE_4409').querySelector('.hamburger-btn'), 'click', 0, 0);
document.getElementById('menu-add-transition').click();
const [x, y] = centerOf(node('STATE_5634'));
fire(window, 'mousemove', x - 30, y);
report({ highlighted: [...document.querySelectorAll('.link-target-candidate')].map(n => n.id) });''', 'hsm_link_hover')
check('linking highlights the innermost state under the cursor (BOOM, not ROOT around it)',
      r is not None and r.get('highlighted') == ['node-STATE_5634'], json.dumps(r))

# ---- Application editor -----------------------------------------------------------------------------------

r = run('app', app, '''
report({ components: document.querySelectorAll('.fa-component').length,
         composite: document.querySelectorAll('.fa-component.composite').length,
         links: document.querySelectorAll('#links-group path').length,
         labels: [...document.querySelectorAll('.transition-label')].map(t => t.textContent),
         board: document.getElementById('app-board-type').value });''', 'app_render')
check('application editor draws the Timebomb application (7 components, 2 composite, 4 connections)',
      r is not None and r.get('components') == 7 and r.get('composite') == 2 and r.get('links') == 4 and
      'ButtonPressed' in r.get('labels', []) and 'DMA stream' in r.get('labels', []) and r.get('board') == 'Board::NucleoF446ZE',
      json.dumps(r))

r = run('app', app, '''
const el = node('C_2'); const rect = el.getBoundingClientRect();
fire(el, 'mousedown', rect.left + 100, rect.top + 60); fire(window, 'mouseup', rect.left + 100, rect.top + 60);
const inputs = [...document.querySelectorAll('#selection-props input')].map(i => i.value);
const model = document.querySelector('#selection-props select');
report({ title: document.getElementById('selection-title').textContent, inputs, model: model && model.value });''', 'app_select')
check('selecting an actor shows its properties: name, state machine, priority, queue, stack',
      r is not None and r.get('title') == 'Actor: Timebomb' and r.get('inputs') == ['Timebomb', '2', '8', '128'] and
      r.get('model') == 'timebomb.hsm.json', json.dumps(r))

r = run('app', app, '''
fire(node('C_1').querySelector('.hamburger-btn'), 'click', 0, 0);
document.getElementById('menu-connect').click();
const [x, y] = centerOf(node('C_2'));
fire(window, 'mousemove', x, y);
fire(node('C_2'), 'click', x, y);
const offered = [...document.querySelectorAll('#events-checklist input')].map(i => i.value);
document.querySelector('#events-checklist input[value="Tick"]').checked = true;
document.getElementById('btn-submit-connection').click();
const edit = window.__edits.filter(m => m.type === 'documentEdit').pop();
const saved = edit ? JSON.parse(edit.jsonText).connections : [];
report({ dialog: document.getElementById('connection-title').innerText, offered, saved: saved[saved.length - 1],
         count: saved.length, drawn: document.querySelectorAll('#links-group path').length });''', 'app_connect')
check("connecting offers the target actor's signals from its model, and saves the connection",
      r is not None and r.get('dialog') == 'ButtonPoller → Timebomb' and r.get('offered') == ['Tick', 'ButtonPressed'] and
      r.get('count') == 5 and r.get('drawn') == 5 and (r.get('saved') or {}).get('events') == ['Tick'] and
      (r.get('saved') or {}).get('from') == 'C_1', json.dumps(r))

r = run('app', app, '''
document.getElementById('add-component-btn').click();
document.getElementById('input-kind').value = 'interrupt';
document.getElementById('input-kind').dispatchEvent(new Event('change'));
document.getElementById('input-parent').value = 'C_3';
document.getElementById('input-name').value = '9bad';
document.getElementById('btn-submit-component').click();
const refused = document.getElementById('hint-name').style.display === 'block';
document.getElementById('input-name').value = 'ButtonIrq';
document.getElementById('btn-submit-component').click();
const edit = window.__edits.filter(m => m.type === 'documentEdit').pop();
const added = edit ? JSON.parse(edit.jsonText).components.find(c => c.name === 'ButtonIrq') : null;
report({ refused, added, shown: Boolean([...document.querySelectorAll('.fa-name')].find(n => n.textContent === 'ButtonIrq')) });''', 'app_add')
check('adding a component: an invalid name is refused; an interrupt module is added inside the chosen subsystem with defaults',
      r is not None and r.get('refused') is True and (r.get('added') or {}).get('kind') == 'interrupt' and
      (r.get('added') or {}).get('parent') == 'C_3' and (r.get('added') or {}).get('pri') == 6 and r.get('shown') is True and
      (r.get('added') or {}).get('x', 0) + (r.get('added') or {}).get('width', 0) <= 80 + 900,      # inside Comms (x 80, width 900)
      json.dumps(r))

# Problems on the diagram: an SPSC service with two producers
broken = json.load(open(app))
broken['components'].append({'id': 'C_9', 'kind': 'spsc', 'name': 'Samples', 'parent': 'APP', 'item': 'uint16_t', 'size': 32,
                             'x': 700, 'y': 130, 'width': 250, 'height': 96})
broken['connections'] += [{'id': 'L_8', 'from': 'C_4', 'to': 'C_9', 'kind': 'item', 'item': 'uint16_t'},
                          {'id': 'L_9', 'from': 'C_5', 'to': 'C_9', 'kind': 'item', 'item': 'uint16_t'}]
broken_path = os.path.join(out_dir, 'broken.app.json')
json.dump(broken, open(broken_path, 'w'))
r = run('app', broken_path, '''
const badge = node('C_9').querySelector('.fa-badge');
const items = [...document.querySelectorAll('#problems-list .problem')];
const spsc = items.find(i => i.textContent.includes('has 2 producers'));
if (spsc) spsc.click();
report({ marked: node('C_9').classList.contains('has-error'), badge: badge && badge.textContent, tooltip: badge && badge.title,
         title: document.getElementById('problems-title').textContent, listed: Boolean(spsc),
         selected: document.getElementById('selection-title').textContent });''', 'app_problems', models_dir=FIXTURES)
check('problems are shown: the SPSC service with two producers is marked, listed, and selected by clicking the problem',
      r is not None and r.get('marked') is True and r.get('badge') == '⛔' and 'has 2 producers' in (r.get('tooltip') or '') and
      r.get('title', '').startswith('Problems (1 error') and r.get('listed') is True and
      r.get('selected') == 'SPSC service: Samples', json.dumps(r))

sys.exit(1 if failures else 0)
