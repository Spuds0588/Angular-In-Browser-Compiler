#!/usr/bin/env node
/* End-to-end check for the demo: real Chromium, headless by default, driven over CDP.
   Asserts the whole V1 feature set end to end — bootstrap, npm-package Sass, VFS assets
   through the HttpInterceptor, Router with the host URL untouched, style fast refresh
   (state-preserving SCSS patches), the unmatched-sheet fallback, the compile-error
   boundary with recovery, and a clean console.

   Usage:  npm test                                  # local server on $NGB_PORT (default 8137)
           npm run test:headed                       # watch it happen
           node test/e2e.mjs --url <page-url>        # check a deployed origin instead
           CHROME_BIN=/path/to/chrome npm test

   Notes:
   - A FRESH Chrome profile per run is mandatory: a stale profile serves cached 404s and
     produces bogus "idle" results (cost two debug cycles in session 4).
   - Node 22+ has a global WebSocket; on older Node run `npm i -D ws` (test-only dependency).
   - The first compile resolves the whole @angular/material Sass graph (~40 s, jsdelivr); a
     cold run can take a few minutes. Everything after that is cached.
*/
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const PORT = Number(process.env.NGB_PORT ?? 8137);
const LOCAL_URL = `http://127.0.0.1:${PORT}/demo/index.html`;
const PAGE_URL = flag('--url') ?? process.env.BASE_URL ?? LOCAL_URL;
const HEADLESS = !args.includes('--headed');
const CHROME = process.env.CHROME_BIN ?? 'google-chrome';

/* ---------------------------------------------------------------------------
   Expected values — keep in sync with demo/demo-app.js.
   $brand = mat.get-color-from-palette(mat.$indigo-palette, 500) is resolved through the
   npm-package Sass importer, so a green h1 proves the whole SCSS pipeline end to end.
--------------------------------------------------------------------------- */
const INDIGO = 'rgb(63, 81, 181)';    // $brand  (#3f51b5, @angular/material indigo-500)
const TEAL = 'rgb(0, 150, 136)';      // $brand  (#009688, @angular/material teal-500 — Recolor)
const ACCENT = 'rgb(192, 57, 43)';    // $accent (#c0392b)
const NAV_BG = 'rgb(241, 245, 249)';  // $nav-bg (#f1f5f9)
const MUTED = 'rgb(136, 136, 136)';   // $muted  (#888)
const DATA = 'Hello from VFS JSON via HttpInterceptor!';
const BROKEN = 'compile error (last-good kept)';

/* ---------------------------------------------------------------------------
   In-page driver. Runs inside the demo page; returns a plain object of observations
   that Node asserts below. `doc()` is the sandboxed iframe's document.
--------------------------------------------------------------------------- */
const PAGE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => document.querySelector('.ng-builder-frame');
  const doc = () => frame() && frame().contentDocument;
  const q = (sel) => (doc() ? doc().querySelector(sel) : null);
  const status = () => document.getElementById('status').textContent;
  const waitFor = async (fn, ms = 120000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { try { if (fn()) return true; } catch (e) {} await sleep(250); }
    return false;
  };
  const cs = (sel, prop) => { const e = q(sel); return e ? getComputedStyle(e)[prop] : null; };
  const text = (sel) => { const e = q(sel); return e ? e.textContent : null; };
  const count = () => text('app-home strong');
  const click = (sel) => { const e = q(sel); if (e) e.click(); };
  const active = () => { const a = doc() && doc().querySelectorAll('nav a.active'); return a ? [].map.call(a, (n) => n.textContent) : null; };
  const styleTexts = () => (doc() ? [].slice.call(doc().head.querySelectorAll('style')).map((n) => n.textContent) : []);
  const logs = (n) => [].slice.call(document.querySelectorAll('#logs li')).slice(0, n).map((li) => li.textContent);
  const out = {};

  out.booted = await waitFor(() => status() === 'app running', 300000);
  out.statusAtBoot = status();
  out.logsAtBoot = logs(6);
  if (!out.booted) { out.consoleErrs = window.__CONSOLE_ERRS__ || []; return out; }
  // Only now is the demo's module graph guaranteed to have run (status exists in static HTML).
  const builder = window.__BUILDER__;

  out.hostUrlAtBoot = location.href;
  out.styleNodeCount = styleTexts().length;
  out.h1 = cs('h1', 'color');
  out.navBg = cs('nav', 'backgroundColor');
  out.hint = cs('.hint', 'color');
  out.interceptor = text('app-home em');

  /* --- Router: navigate, exclusive active classes, host URL never changes --- */
  doc().querySelectorAll('nav a')[1].click();
  await waitFor(() => q('app-about h2'));
  out.about = text('app-about h2');
  out.activeAfterAbout = active();
  out.hostUrlAfterNav = location.href;
  doc().querySelectorAll('nav a')[0].click();
  await waitFor(() => q('app-home'));
  out.activeBackHome = active();

  /* --- Style fast refresh: route + component state must both survive --- */
  for (let i = 0; i < 3; i++) { click('app-home button'); await sleep(60); }
  out.countBefore = count();
  const nodesBefore = styleTexts().length;
  document.getElementById('btn-recolor').click();
  out.patched = await waitFor(() => cs('h1', 'color') === 'rgb(0, 150, 136)', 60000);
  out.h1AfterPatch = cs('h1', 'color');
  out.countAfterPatch = count();
  out.activeAfterPatch = active();
  out.statusAfterPatch = status();
  out.styleNodesPatch = [nodesBefore, styleTexts().length];
  out.patchedShim = (styleTexts().filter((t) => t.indexOf('h1') !== -1)[0] || '');
  out.logsAfterPatch = logs(3);

  /* --- The next soft reload must inherit the PATCHED css, not the original --- */
  const appTs = builder.getFile('src/app/app.component.ts');
  builder.updateFile('src/app/app.component.ts', appTs + String.fromCharCode(10) + '// e2e soft-reload probe' + String.fromCharCode(10));
  await waitFor(() => status() === 'app running' && count() === '0');
  out.countAfterSoftReload = count();
  out.h1AfterSoftReload = cs('h1', 'color');

  /* --- A second patch must start from the patched sheet and keep state --- */
  click('app-home button'); click('app-home button');
  await sleep(100);
  document.getElementById('btn-recolor').click();
  out.backToBrand = await waitFor(() => cs('h1', 'color') === 'rgb(63, 81, 181)', 60000);
  out.h1AfterSecondPatch = cs('h1', 'color');
  out.countAfterSecondPatch = count();

  /* --- Bonus: an ADDED rule and a nested at-rule in the OTHER component's sheet --- */
  click('app-home button'); click('app-home button');
  await sleep(100);
  const NL = String.fromCharCode(10);
  const homeScss = builder.getFile('src/app/home.component.scss');
  builder.updateFile('src/app/home.component.scss', homeScss + NL +
    'strong { color: variables.$accent; }' + NL +
    '@media (min-width: 1px) { .hint { letter-spacing: 2px; } }' + NL);
  out.addedRule = await waitFor(() => cs('app-home strong', 'color') === 'rgb(192, 57, 43)' && cs('.hint', 'letterSpacing') === '2px', 60000);
  out.addedRuleColor = cs('app-home strong', 'color');
  out.addedRuleSpacing = cs('.hint', 'letterSpacing');
  out.countAfterAddedRule = count();

  /* --- HTML-only edit: still a full soft reload (documents the Phase 8 template gap) --- */
  const homeHtml = builder.getFile('src/app/home.component.html');
  builder.updateFile('src/app/home.component.html', homeHtml.replace('>+1<', '>+1!<'));
  out.htmlReload = await waitFor(() => text('app-home button') === '+1!');
  out.buttonLabel = text('app-home button');
  out.countAfterHtmlEdit = count();
  out.h1AfterHtmlEdit = cs('h1', 'color');

  /* --- Fallback: an unmatchable DOM state must degrade to a soft reload, never a no-op --- */
  [].slice.call(doc().head.querySelectorAll('style'))
    .filter((n) => n.textContent.indexOf('_ngcontent') !== -1)
    .forEach((n) => n.remove());
  const appScss = builder.getFile('src/app/app.component.scss');
  builder.updateFile('src/app/app.component.scss', appScss + NL + 'h1 { font-style: italic; }' + NL);
  out.fallbackReload = await waitFor(() => status() === 'app running' && cs('h1', 'fontStyle') === 'italic');
  out.fallbackFontStyle = cs('h1', 'fontStyle');
  out.fallbackLogs = logs(3);

  /* --- Compile-error boundary: last good build stays on screen, then recovery --- */
  builder.updateFile('src/app/app.component.ts', appTs.replace('export class AppComponent', 'export class AppComponent { const x = ;'));
  await waitFor(() => window.__LAST_ERR__, 60000);
  out.breakStatus = status();
  out.broke = !!window.__LAST_ERR__;
  out.renderedWhileBroken = !!q('app-home');
  out.logsWhileBroken = logs(3);
  builder.updateFile('src/app/app.component.ts', appTs);
  out.recovered = await waitFor(() => status() === 'app running' && q('app-home'));
  out.fixStatus = status();
  out.h1AfterFix = cs('h1', 'color');

  /* --- V2 LLM bridge: window.__NG_BUILDER_MCP__ (PRD Phase 9) --- */
  const mcp = window.__NG_BUILDER_MCP__;
  out.mcpExists = !!mcp;
  if (mcp) {
    click('app-home button'); click('app-home button');
    await sleep(100);
    out.mcpCountBefore = count();
    const vfs = mcp.readVFS();
    out.mcpVfsFiles = Object.keys(vfs).length;
    out.mcpVfsMain = typeof vfs['src/main.ts'] === 'string';
    const dom = mcp.inspectDOM('app-home');
    const tags = [];
    if (dom) (function collect(n) { tags.push(n.tag); (n.children || []).forEach(collect); })(dom.root);
    out.mcpDomTags = tags;
    const idle = await mcp.patchFiles({
      'src/app/_variables.scss': vfs['src/app/_variables.scss'].replace('$indigo-palette', '$teal-palette'),
    });
    out.mcpIdle = idle && idle.status;
    out.mcpH1 = cs('h1', 'color');
    out.mcpCountAfter = count();
    const entries = mcp.getStructuredLogs();
    out.mcpLogCount = entries.length;
    out.mcpLogFields = entries.length ? Object.keys(entries[0]).sort().join(',') : null;
    out.mcpLogDomains = entries.length ? [...new Set(entries.map((e) => e.domain))] : [];
    out.mcpTimeout = (await mcp.whenIdle(1)).status;   // nothing in flight -> the guard fires
    out.mcpStyleDomains = out.mcpLogDomains;

    /* A TS edit opens a new cycle — the logs must follow it, not stay on the style patch. */
    const idle2 = await mcp.patchFiles({
      'src/app/home.component.ts': vfs['src/app/home.component.ts'] + String.fromCharCode(10) + '// mcp cycle probe' + String.fromCharCode(10),
    });
    out.mcpSecondIdle = idle2.status;
    const entries2 = mcp.getStructuredLogs();
    out.mcpTsLogCount = entries2.length;
    out.mcpTsDomains = [...new Set(entries2.map((e) => e.domain))];

    /* The demo's own MCP button must drive the same bridge through the UI. */
    document.getElementById('btn-agent').click();
    await waitFor(() => document.querySelector('#logs li.mcp'));
    out.agentLine = (document.querySelector('#logs li.mcp') || {}).textContent || null;
    out.agentLineCount = count();
  }

  out.consoleErrs = window.__CONSOLE_ERRS__ || [];
  out.logsTail = logs(4);
  return out;
})()`;

/* ---------------------------------------------------------------------------
   Harness
--------------------------------------------------------------------------- */
const webSocketImpl = globalThis.WebSocket
  ?? await import('ws').then((m) => m.default).catch(() => null);
if (!webSocketImpl) {
  console.error('No WebSocket implementation — use Node 22+ or `npm i -D ws`.');
  process.exit(1);
}

let server = null;
let chrome = null;
let profile = null;
const cleanups = [];
const shutdown = () => {
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* already gone */ } }
};
process.on('exit', shutdown);

const local = PAGE_URL === LOCAL_URL;
if (local) {
  server = spawn('node', [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))],
    { env: { ...process.env, NGB_PORT: String(PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
  cleanups.push(() => server.kill('SIGKILL'));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(LOCAL_URL)).ok; } catch { await sleep(250); }
  }
  if (!up) { console.error(`server never answered on ${LOCAL_URL}`); process.exit(1); }
}
console.log(`→ ${PAGE_URL} (${HEADLESS ? 'headless' : 'headed'} Chromium)`);

profile = await mkdtemp(join(tmpdir(), 'ngb-e2e-'));
chrome = spawn(CHROME, [
  ...(HEADLESS ? ['--headless=new'] : []),
  '--remote-debugging-port=0',       // Chrome reports the chosen port in DevToolsActivePort
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
  '--disable-dev-shm-usage', 'about:blank',
], { stdio: 'ignore' });
cleanups.push(() => chrome.kill('SIGKILL'));
cleanups.push(() => rm(profile, { recursive: true, force: true }));

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch { /* not up yet */ }
  await sleep(250);
}
if (!wsUrl) { console.error('CDP never came up — is Chrome installed? (CHROME_BIN=...)'); process.exit(1); }

const ws = new webSocketImpl(wsUrl);
await new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error('CDP websocket never opened')), 10000);
  ws.addEventListener('open', () => { clearTimeout(timer); res(); });
});
let seq = 0;
const pending = new Map();
const consoleLogs = [];
ws.addEventListener('message', (event) => {
  const d = JSON.parse(event.data.toString());
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.consoleAPICalled') {
    consoleLogs.push((d.params.args ?? []).map((a) => a.value ?? a.description).join(' '));
  }
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
    // CDP's `text` omits the resource, so record the url too — that is what the
    // favicon filter below matches on.
    const entry = d.params.entry;
    consoleLogs.push(`LOG-ERR ${entry.url ?? '(no url)'} — ${entry.text}`.trim());
  }
});
const send = (method, params, sessionId) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Page.navigate', { url: PAGE_URL }, sessionId);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true }, sessionId);
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
  return r.result?.result?.value;
};

for (let i = 0; i < 120; i++) {           // wait for the demo page (not the app) to load
  if ((await evaluate('document.getElementById("status") ? "yes" : null')) === 'yes') break;
  await sleep(250);
}
await evaluate('window.__CONSOLE_ERRS__ = []; window.addEventListener("error", (e) => window.__CONSOLE_ERRS__.push(String(e.message))); "hooked"');

console.log('running the suite (first compile resolves the @angular/material Sass graph; ~40 s)…');
const out = await evaluate(PAGE_SCRIPT);

/* ---------------------------------------------------------------------------
   Assertions
--------------------------------------------------------------------------- */
const checks = [];
const check = (name, ok, actual) => checks.push({ name, ok: !!ok, actual });
const eq = (name, actual, expected) => check(`${name} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`, actual === expected, actual);

check('boot: app reaches "app running"', out.statusAtBoot === 'app running', out.statusAtBoot);
if (out.booted) {
  eq('boot: two injected <style> nodes', out.styleNodeCount, 2);
  eq('boot: $brand (Material indigo-500) on h1', out.h1, INDIGO);
  eq('boot: shared $nav-bg token on nav', out.navBg, NAV_BG);
  eq('boot: shared $muted token on .hint', out.hint, MUTED);
  eq('boot: HttpInterceptor serves assets/data.json from the VFS', out.interceptor, DATA);

  eq('router: /about renders', out.about, 'About');
  eq('router: active link is exclusive (About)', JSON.stringify(out.activeAfterAbout), JSON.stringify(['About']));
  eq('router: host URL untouched by navigation', out.hostUrlAfterNav, out.hostUrlAtBoot);
  eq('router: back Home', JSON.stringify(out.activeBackHome), JSON.stringify(['Home']));

  eq('state: +1 three times', out.countBefore, '3');
  check('fast refresh: $brand -> teal', out.patched && out.h1AfterPatch === TEAL, out.h1AfterPatch);
  eq('fast refresh: component state preserved', out.countAfterPatch, '3');
  eq('fast refresh: active route preserved', JSON.stringify(out.activeAfterPatch), JSON.stringify(['Home']));
  eq('fast refresh: no re-bootstrap', out.statusAfterPatch, 'app running');
  eq('fast refresh: style node count stable', JSON.stringify(out.styleNodesPatch), JSON.stringify([2, 2]));
  check('fast refresh: patched Angular-shimmed CSS (_ngcontent)', out.patchedShim.includes('_ngcontent'), out.patchedShim.slice(0, 60));

  eq('soft reload after patch: state resets', out.countAfterSoftReload, '0');
  eq('soft reload after patch: patched CSS inherited', out.h1AfterSoftReload, TEAL);
  check('fast refresh #2: back to indigo with state kept',
    out.backToBrand && out.h1AfterSecondPatch === INDIGO && out.countAfterSecondPatch === '2',
    `${out.h1AfterSecondPatch} / count ${out.countAfterSecondPatch}`);
  check('fast refresh: appended rule applies', out.addedRuleColor === ACCENT, out.addedRuleColor);
  eq('fast refresh: nested @media applies', out.addedRuleSpacing, '2px');
  eq('fast refresh: state survives the second sheet patch', out.countAfterAddedRule, '4');

  eq('html edit: template change soft-reloads', out.buttonLabel, '+1!');
  eq('html edit: state resets (no template HMR in Angular 17)', out.countAfterHtmlEdit, '0');
  eq('html edit: patch CSS survives the reload', out.h1AfterHtmlEdit, INDIGO);

  check('fallback: unmatched sheet degrades to a soft reload',
    out.fallbackReload && out.fallbackFontStyle === 'italic', out.fallbackFontStyle);

  eq('error boundary: compile error keeps the last good build', out.breakStatus, BROKEN);
  check('error boundary: previous app still rendered while broken', out.renderedWhileBroken, out.renderedWhileBroken);
  check('recovery: fixing the file restores the app', out.recovered && out.fixStatus === 'app running', out.fixStatus);
  eq('recovery: styles intact', out.h1AfterFix, INDIGO);

  check('mcp: window.__NG_BUILDER_MCP__ is exposed', out.mcpExists === true, out.mcpExists);
  if (out.mcpExists) {
    check('mcp: readVFS returns the whole VFS', out.mcpVfsFiles >= 12 && out.mcpVfsMain === true,
      `${out.mcpVfsFiles} files, main.ts present: ${out.mcpVfsMain}`);
    check('mcp: inspectDOM returns the sandbox tree',
      Array.isArray(out.mcpDomTags) && out.mcpDomTags.includes('strong') && out.mcpDomTags.includes('button'),
      JSON.stringify(out.mcpDomTags));
    eq('mcp: patchFiles settles once the build is done', out.mcpIdle, 'ok');
    eq('mcp: patchFiles drives the HMR pipeline', out.mcpH1, TEAL);
    eq('mcp: patchFiles preserves component state', out.mcpCountAfter, out.mcpCountBefore);
    check('mcp: getStructuredLogs returns structured entries',
      out.mcpLogFields === 'data,domain,level,message,ts' && out.mcpLogCount > 0,
      `${out.mcpLogCount} entries, fields ${out.mcpLogFields}`);
    check('mcp: getStructuredLogs returns the latest cycle, not a stale one',
      out.mcpStyleDomains.includes('HMR') && !out.mcpStyleDomains.includes('Pipeline'),
      `style cycle: ${JSON.stringify(out.mcpStyleDomains)}`);
    check('mcp: a later build opens a new cycle (TS edit → Pipeline/Sandbox)',
      out.mcpSecondIdle === 'ok' && out.mcpTsDomains.includes('Pipeline') && out.mcpTsDomains.includes('Sandbox'),
      `${out.mcpSecondIdle}: ${JSON.stringify(out.mcpTsDomains)} (${out.mcpTsLogCount} entries)`);
    eq('mcp: whenIdle times out when no build is pending', out.mcpTimeout, 'timeout');
    check('demo: the Agent (MCP) button drives the bridge',
      typeof out.agentLine === 'string' && out.agentLine.includes('patchFiles -> ok') && out.agentLine.includes('readVFS 12 files'),
      out.agentLine);
  }

  eq('no uncaught page errors', JSON.stringify(out.consoleErrs), '[]');
}
const logErrors = consoleLogs.filter((l) => l.startsWith('LOG-ERR'));
const benign = logErrors.filter((l) => l.includes('/favicon.ico'));
eq('no console errors (benign favicon 404 ignored)',
  JSON.stringify(logErrors.filter((l) => !l.includes('/favicon.ico'))), '[]');
if (benign.length) console.log(`  note  ignoring ${benign.length} benign favicon 404: ${benign[0]}`);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (out.logsAtBoot) { console.log('--- demo log tail ---'); console.log(out.logsTail ?? out.logsAtBoot); }
if (failed.length || !out.booted) {
  console.log('--- observations ---');
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
  console.log('--- browser console (last 20) ---');
  console.log(consoleLogs.slice(-20).join('\n'));
}
shutdown();
process.exit(failed.length ? 1 : 0);
