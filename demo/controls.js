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

builder.on('log', (entry) => {
  const li = document.createElement('li');
  li.className = entry.level;
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  li.textContent = `[${time}] [AngularBuilder::${entry.domain}] ${entry.message}` +
    (entry.data ? ' ' + JSON.stringify(entry.data) : '');
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.lastChild.remove();
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