import { AngularBrowserBuilder } from '../src/angular-browser-builder.js';
import { appFiles } from './demo-app.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('logs');

const GOOD_TS = appFiles['src/app/app.component.ts'];
const GOOD_HTML = appFiles['src/app/app.component.html'];

$('ts-editor').value = GOOD_TS;
$('html-editor').value = GOOD_HTML;

const builder = new AngularBrowserBuilder({ container: $('frame-host') });
window.__BUILDER__ = builder;

/* The V2 LLM bridge the demo drives below. */
const mcp = window.__NG_BUILDER_MCP__;

const appendLog = (text, cls = '') => {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.lastChild.remove();
};

builder.on('log', (entry) => {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  appendLog(`[${time}] [AngularBuilder::${entry.domain}] ${entry.message}` +
    (entry.data ? ' ' + JSON.stringify(entry.data) : ''), entry.level);
});

builder.on('success', () => { statusEl.textContent = 'app running'; statusEl.className = 'ok'; });
builder.on('compileError', (e) => { statusEl.textContent = 'compile error (last-good kept)'; statusEl.className = 'bad'; window.__LAST_ERR__ = e && e.data; });
builder.on('runtimeError', (e) => { statusEl.textContent = 'runtime error (last-good kept)'; statusEl.className = 'bad'; window.__LAST_ERR__ = e; });

$('btn-apply').addEventListener('click', () => {
  builder.batch({
    'src/app/app.component.ts': $('ts-editor').value,
    'src/app/app.component.html': $('html-editor').value,
  });
});

/* Style-only edit: flips the shared $brand token (indigo <-> teal). The builder
   patches the live <style> nodes instead of re-bootstrapping, so the counter and the
   active route survive the change. */
const GOOD_SCSS = appFiles['src/app/_variables.scss'];
let alt = false;
$('btn-recolor').addEventListener('click', () => {
  alt = !alt;
  builder.updateFile('src/app/_variables.scss',
    GOOD_SCSS.replace('mat.$indigo-palette', alt ? 'mat.$teal-palette' : 'mat.$indigo-palette'));
});

/* V2 LLM bridge: exactly what an agent driving browser-skills does — read the VFS, patch
   a file, wait for the build to settle, then read the structured logs and the sandbox DOM.
   No editor, no button state, no host UI involved. */
$('btn-agent').addEventListener('click', async () => {
  const vfs = mcp.readVFS();
  const tokens = vfs['src/app/_variables.scss'];
  const toTeal = tokens.includes('$indigo-palette');
  const t0 = performance.now();
  const idle = await mcp.patchFiles({
    'src/app/_variables.scss': tokens.replace(toTeal ? '$indigo-palette' : '$teal-palette',
      toTeal ? '$teal-palette' : '$indigo-palette'),
  });
  const tags = [];
  (function collect(node) { tags.push(node.tag); (node.children || []).forEach(collect); })(mcp.inspectDOM('app-home').root);
  appendLog(`[MCP] patchFiles -> ${idle.status} in ${Math.round(performance.now() - t0)} ms` +
    ` | readVFS ${Object.keys(vfs).length} files | getStructuredLogs ${mcp.getStructuredLogs().length}` +
    ` | inspectDOM ${tags.join(' > ')}`, 'mcp');
});

$('btn-break').addEventListener('click', () => {
  $('ts-editor').value = GOOD_TS.replace('export class AppComponent', 'export class AppComponent { const x = ;');
  builder.updateFile('src/app/app.component.ts', $('ts-editor').value);
});

$('btn-fix').addEventListener('click', () => {
  $('ts-editor').value = GOOD_TS;
  $('html-editor').value = GOOD_HTML;
  builder.batch({
    'src/app/app.component.ts': GOOD_TS,
    'src/app/app.component.html': GOOD_HTML,
  });
});

statusEl.textContent = 'building…';
builder.setFiles(appFiles);