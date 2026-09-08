/**
 * angular-browser-builder.js
 * ---------------------------------------------------------------------------
 * A front-end-only, zero-backend, browser-based compiler & builder for Angular (v17+).
 * Drop-in ESM library — no bundler, no Node, no build step.
 *
 * Pipeline (every rebuild):
 *   VFS -> regex import scan -> esm.sh pre-fetch (default mode + ?deps pin) -> TS -> CommonJS
 *   -> postMessage into sandboxed iframe (srcdoc doc) -> Angular JIT bootstrap.
 *
 * Design rules (see history.md / agent.md):
 *   - Host never evals. TS transpiles on the host (pure computation); `new Function`
 *     only ever runs inside the sandboxed iframe. Chromium inherits the host CSP into
 *     srcdoc/data: iframes, so the host's script-src needs 'unsafe-eval' (plus blob: for
 *     the runner script) — eval stays confined to the sandbox; no 'unsafe-inline' needed.
 *   - templateUrl/styleUrl are rewritten to template:/styles: with require() — Angular JIT
 *     would otherwise try to FETCH the URL string at runtime.
 *   - Framework packages (@angular/*, rxjs, tslib) are fetched from esm.sh in DEFAULT mode
 *     (all cross-package imports rewritten to absolute URLs — no bare specifiers, no import
 *     map needed) with `?deps=rxjs@…,tslib@…` pinning so @angular/core / rxjs stay a single
 *     shared copy (dupes break DI and `instanceof Observable`). `?bundle&external=` must NOT
 *     be used: it emits bare specifiers that need an import map (inline import maps are
 *     CSP-blocked without unsafe-inline).
 */
const ESM_SH = 'https://esm.sh';
const CDN = 'https://cdn.jsdelivr.net/npm';

const FRAMEWORK = [
  '@angular/core', '@angular/common', '@angular/common/http', '@angular/compiler',
  '@angular/forms', '@angular/router', '@angular/platform-browser', 'rxjs', 'tslib',
];

const DEFAULT_VERSIONS = {
  '@angular/core': '17.3.12', '@angular/common': '17.3.12', '@angular/common/http': '17.3.12',
  '@angular/compiler': '17.3.12',
  '@angular/forms': '17.3.12', '@angular/router': '17.3.12', '@angular/platform-browser': '17.3.12',
  rxjs: '7.8.1', tslib: '2.6.3',
  'zone.js': '0.14.10', 'reflect-metadata': '0.2.2', typescript: '5.4.5', sass: '1.86.3',
};

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
};

const TS_OPTIONS = (ts) => ({
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  experimentalDecorators: true, emitDecoratorMetadata: true,
  esModuleInterop: true, allowSyntheticDefaultImports: true,
});

const extname = (p) => ((p.match(/\.([^./]+)$/) || [])[1] || '').toLowerCase();
const isExternalSpec = (s) => !s.startsWith('.') && !s.startsWith('/') && !/^[a-z]+:/.test(s);
const stringModule = (content) => `module.exports = ${JSON.stringify(content)};`;

/** Static + dynamic import specifiers from TS source. */
function extractImports(src) {
  return [...src.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .concat([...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));
}

/** esm.sh-relative absolute import paths (`/pkg@ver?...`) inside a fetched bundle. */
function extractUrlImports(text) {
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\/[^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * The runner executed inside the sandboxed iframe.
 * Must be 100% self-contained (serialized via toString()); no closures over module scope,
 * no backticks/template literals.
 */
function RUNNER() {
  var cache = new Map();
  var payload = null;
  var externals = null;

  function post(msg) {
    msg.__ngBuilder = true;
    parent.postMessage(msg, '*');
  }

  function resolve(dir, spec) {
    if (externals && Object.prototype.hasOwnProperty.call(externals, spec)) return { ext: externals[spec] };
    var parts = spec.split('/');
    var out = dir ? dir.split('/') : [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '.' || p === '') continue;
      if (p === '..') out.pop();
      else out.push(p);
    }
    if (out[0] === '') out.shift(); /* leading '/' => VFS root */
    var base = out.join('/');
    var exts = ['', '.js', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];
    for (var j = 0; j < exts.length; j++) {
      var key = base + exts[j];
      if (payload.modules[key]) return { mod: key };
    }
    return null;
  }

  function loadModule(path) {
    if (cache.has(path)) return cache.get(path).exports;
    var code = payload.modules[path];
    if (code === undefined) throw new Error('Cannot find module: ' + path);
    var m = { exports: {} };
    cache.set(path, m);
    var dir = path.split('/').slice(0, -1).join('/');
    var requireFn = function (spec) {
      var r = resolve(dir, spec);
      if (!r) throw new Error('Cannot resolve module "' + spec + '" from "' + path + '"');
      return r.ext ? r.ext : loadModule(r.mod);
    };
    Function('exports', 'require', 'module', code)(m.exports, requireFn, m);
    return m.exports;
  }

  function destroyOldApp() {
    var ref = window.__NG_APP_REF__;
    if (ref && ref.destroy) { try { ref.destroy(); } catch (e) {} return true; }
    return false;
  }

  self.onmessage = function (ev) {
    var d = ev.data || {};
    if (d.type !== 'bootstrap') return;
    payload = d;
    cache.clear();
    if (window.__NG_BOOTED__ && !destroyOldApp()) {
      /* App didn't expose its ApplicationRef — hard-reset the iframe document. */
      window.__NG_SKIP_RESET__ = true;
      location.reload();
      return;
    }
    if (window.__NG_SKIP_RESET__) delete window.__NG_SKIP_RESET__;
    window.__NG_BOOTED__ = true;
    /* VFS has no index.html: give bootstrapApplication() a mounting element per
       component selector found in the sources. */
    if (d.roots) for (var i = 0; i < d.roots.length; i++) {
      var oldEl = document.querySelector(d.roots[i]);
      if (oldEl) oldEl.remove();
      document.body.appendChild(document.createElement(d.roots[i]));
    }
    boot(d).then(
      function () { post({ type: 'bootstrapped', ok: true }); },
      function (err) {
        post({ type: 'bootstrapped', ok: false, error: { message: (err && err.message) || String(err), stack: err && err.stack } });
      }
    );
  };

  async function boot(d) {
    window.process = window.process || { env: { NODE_ENV: 'development' } };
    var entries = Object.entries(d.externals || {});
    var urls = entries.map(function (e) { return e[1]; }).filter(function (u, i, a) { return a.indexOf(u) === i; });
    var loaded = new Map();
    /* @angular/compiler must be evaluated BEFORE any @angular module: their static
       blocks JIT-compile partial declarations (ngDeclareFactory/Injectable) at module
       evaluation time, which needs the compiler facade on window.ng. Parallel import
       can evaluate the Angular module first -> facade missing -> JIT compile fails. */
    var compilerUrl = null;
    for (var i = 0; i < entries.length; i++) if (entries[i][0] === '@angular/compiler') compilerUrl = entries[i][1];
    if (compilerUrl && urls.indexOf(compilerUrl) !== -1) loaded.set(compilerUrl, await import(compilerUrl));
    await Promise.all(urls.filter(function (u) { return u !== compilerUrl; }).map(function (u) {
      return import(u).then(function (ns) { loaded.set(u, ns); });
    }));
    externals = {};
    for (var i = 0; i < entries.length; i++) externals[entries[i][0]] = loaded.get(entries[i][1]);
    window.__NG_VFS_ASSETS__ = d.assets || {};
    loadModule(d.main || 'src/main.ts');
  }

  self.onerror = function (e) {
    post({ type: 'runtimeError', error: { message: (e && e.message) || String(e), stack: e && e.stack } });
    return false;
  };

  post({ type: 'ready' });
}
const RUNNER_SOURCE = '(' + RUNNER.toString() + ')()';

export class AngularBrowserBuilder {
  constructor({ container, versions = {}, main = 'src/main.ts' } = {}) {
    this.container = container;
    this.versions = { ...DEFAULT_VERSIONS, ...versions };
    this.main = main;
    this.files = new Map();
    this.listeners = new Map();
    this.frame = null;
    this.booted = false;
    this.lastGood = null;
    this.pending = null;
    this._ts = null;
    this._sass = null;
    this._depCache = new Map();
    this._onFrameMessage = (ev) => {
      const d = ev.data;
      if (!d || !d.__ngBuilder) return;
      if (d.type === 'ready') {
        this.log('Sandbox', 'info', 'sandbox ready');
        const p = this.pending || this.lastGood;
        if (p) { this.pending = null; this._sendToFrame({ type: 'bootstrap', ...p }); }
      } else if (d.type === 'bootstrapped') {
        if (d.ok) {
          this.booted = true;
          this.log('Sandbox', 'info', 'app bootstrapped');
          this.emit('success', { ...this.lastGood });
        } else {
          this.log('Sandbox', 'error', 'bootstrap failed — keeping last-good build', d.error);
          this.emit('runtimeError', d.error);
        }
      } else if (d.type === 'runtimeError') {
        this.log('Sandbox', 'error', 'runtime error — keeping last-good build', d.error);
        this.emit('runtimeError', d.error);
      }
    };
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) || []) { try { fn(payload); } catch (e) { console.error(e); } }
  }

  log(domain, level, message, data) {
    const entry = { ts: Date.now(), level, domain, message, data };
    console.log(`[AngularBuilder::${domain}] ${message}`, data ?? '');
    this.emit('log', entry);
    return entry;
  }

  /* ---------------------------------------------------------- public API */

  getFile(path) { return this.files.get(path); }

  setFiles(files) { this.files = new Map(Object.entries(files)); return this.rebuild(); }

  updateFile(path, content) { this.files.set(path, content); return this.rebuild(); }

  /** Atomically apply several file edits with a single rebuild (one build, not N). */
  batch(files) { for (const [p, c] of Object.entries(files)) this.files.set(p, c); return this.rebuild(); }

  deleteFile(path) { this.files.delete(path); return this.rebuild(); }

  /* ------------------------------------------------------------ pipeline */

  async rebuild() {
    this.log('Pipeline', 'info', 'build started', { files: this.files.size });
    try {
      const ts = await this._loadTypescript();
      const specs = new Set(['@angular/common', '@angular/common/http', 'rxjs', '@angular/compiler']);
      for (const [path, src] of this.files) {
        if (extname(path) === 'ts') for (const s of extractImports(src)) if (isExternalSpec(s)) specs.add(s);
      }
      const externals = await this._prefetch([...specs]);
      this.log('Prefetch', 'info', 'dependencies resolved', { externals: Object.keys(externals).length });

      const assets = {};
      for (const [path, src] of this.files) {
        const ext = extname(path);
        if (['ts', 'html', 'css', 'scss', 'json'].includes(ext)) continue;
        const type = MIME[ext] || 'application/octet-stream';
        const blob = src.startsWith('data:')
          ? new Blob([Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), (c) => c.charCodeAt(0))], { type })
          : new Blob([src], { type });
        assets[path] = { content: src, type, blobUrl: URL.createObjectURL(blob) };
      }

      const modules = {};
      for (const [path, src] of this.files) {
        const ext = extname(path);
        if (ext === 'ts') {
          let code = src;
          if (path === this.main) code = this._injectShims(code);
          code = this._inlineResources(code);
          const out = ts.transpileModule(code, { compilerOptions: TS_OPTIONS(ts), reportDiagnostics: true });
          if (out.diagnostics && out.diagnostics.length) {
            throw new Error(out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
          }
          modules[path] = out.outputText;
        } else if (ext === 'html') {
          modules[path] = stringModule(this._rewriteTemplateAssets(src, assets));
        } else if (ext === 'css') {
          modules[path] = stringModule(this._rewriteCssAssets(src, assets));
        } else if (ext === 'scss') {
          modules[path] = stringModule(this._rewriteCssAssets(await this._compileScss(src, path), assets));
        } else if (ext === 'json') {
          modules[path] = stringModule(src);
          assets[path] = { content: src, type: 'application/json' };
        }
      }

      /* Root elements to pre-create in the sandbox (VFS has no index.html, so
         bootstrapApplication needs a host element). Skip selectors used as tags in
         templates; when a template has a <router-outlet>, only the first selector
         (the shell) is pre-created — the Router instantiates routed components. */
      const srcs = [...this.files.values()];
      const usedTags = new Set(srcs.flatMap((src) => [...src.matchAll(/<([a-z][\w-]*)/g)].map((m) => m[1])));
      const allSelectors = [
        ...new Set(srcs.flatMap((src) =>
          [...src.matchAll(/selector\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))),
      ];
      const routed = srcs.some((src) => src.includes('<router-outlet'));
      const roots = allSelectors.filter((s, i) => !usedTags.has(s) && !(routed && i > 0));
      this.lastGood = { main: this.main, modules, externals, assets, roots };
      this._ensureFrame();
      if (this.booted) {
        this._sendToFrame({ type: 'bootstrap', ...this.lastGood });
      } else {
        this.pending = { ...this.lastGood };
      }
      this.log('Pipeline', 'info', 'compile succeeded — sent to sandbox', {
        modules: Object.keys(modules).length,
        externals: Object.keys(externals).length,
        assets: Object.keys(assets).length,
      });
    } catch (err) {
      const entry = this.log('Pipeline', 'error', 'compile error — keeping last-good build', { message: err.message, stack: err.stack });
      this.emit('compileError', entry);
    }
    return this;
  }

  /** esm.sh pre-fetcher. Framework set uses default (non-bundle) mode with `?deps=`
   *  pinning rxjs/tslib — esm.sh rewrites all cross-package imports to ABSOLUTE URLs
   *  (no bare specifiers, no import map needed) and the deps pin keeps ONE copy of
   *  rxjs/tslib (dupes break `instanceof Observable` and Angular DI). User deps get
   *  `?bundle` (self-contained, everything inlined). */
  async _prefetch(specs) {
    const fetchText = (url) => {
      if (!this._depCache.has(url)) {
        this._depCache.set(url, fetch(url).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
          return r.text();
        }));
      }
      return this._depCache.get(url);
    };
    const seen = new Set();
    const visit = async (url) => {
      if (seen.has(url)) return;
      seen.add(url);
      const text = await fetchText(url);
      for (const rel of extractUrlImports(text)) await visit(ESM_SH + rel);
    };

    const deps = ['rxjs', 'tslib'].map((d) => `${d}@${this.versions[d]}`).join(',');
    const wants = new Map(); /* spec -> canonical esm.sh URL */
    for (const spec of specs) {
      const v = this.versions[spec];
      const m = spec.match(/^(@[^/]+\/[^/]+)(?:\/(.*))?$/);
      const path = m ? `${m[1]}${v ? '@' + v : ''}${m[2] ? '/' + m[2] : ''}` : `${spec}${v ? '@' + v : ''}`;
      const suffix = FRAMEWORK.includes(spec) && deps ? `?deps=${deps}` : '?bundle';
      wants.set(spec, `${ESM_SH}/${path}${suffix}`);
    }
    for (const url of wants.values()) await visit(url); /* warm the CDN cache + fail fast */

    const externals = {};
    for (const [spec, url] of wants) externals[spec] = url;
    return externals;
  }

  _loadTypescript() {
    if (!this._ts) {
      this._ts = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = `${CDN}/typescript@${this.versions.typescript}/lib/typescript.min.js`;
        s.onload = () => res(window.ts);
        s.onerror = () => rej(new Error('failed to load typescript from ' + s.src));
        document.head.appendChild(s);
      });
    }
    return this._ts;
  }

  /** Resolve a sass @import/@use against the VFS. Returns the vfs: URL of the file,
   *  or null to let sass fall through (https: etc.). Resolution order: partial first
   *  (dart-sass convention: `name` -> `_name.scss`), then directory `_index.scss`. */
  _sassImporter() {
    const files = this.files;
    const clean = (p) => {
      const out = [];
      for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
      }
      return out.join('/');
    };
    const hit = (p) => (files.has(p) ? p : files.has('src/' + p) ? 'src/' + p : null);
    return {
      /* sass hands us the import string (with any ./ prefix already normalized away)
         plus the containing file's URL; resolve it against that file's directory,
         with a VFS-root fallback (bare-specifier convenience — no node_modules). */
      canonicalize(url, { containingUrl } = {}) {
        const dir = containingUrl ? clean(containingUrl.pathname).replace(/\/[^/]+$/, '') : '';
        const bases = url.startsWith('/')
          ? [clean(url)]
          : containingUrl ? [clean(`${dir}/${url}`), clean(url)] : [clean(url)];
        for (const base of [...new Set(bases)]) {
          if (/\.(scss|sass|css)$/.test(base)) {
            const p = hit(base);
            if (p) return new URL('vfs:' + p);
            continue;
          }
          const i = base.lastIndexOf('/');
          const d = i > 0 ? base.slice(0, i) : '';
          const name = base.slice(i + 1);
          for (const c of [`${d}/${name}.scss`, `${d}/${name}.sass`, `${d}/_${name}.scss`, `${d}/_${name}.sass`, `${d}/${name}/_index.scss`, `${d}/${name}/index.scss`]) {
            const p = hit(c);
            if (p) return new URL('vfs:' + p);
          }
        }
        return null;
      },
      load(canonicalUrl) {
        const p = canonicalUrl.pathname.replace(/^\//, '');
        if (!files.has(p)) return null;
        return { contents: files.get(p), syntax: p.endsWith('.sass') ? 'indented' : 'scss' };
      },
    };
  }

  async _compileScss(src, path = '') {
    // esm.sh's sass shim calls require('url') internally; install a global stub once.
    // Must run before the module's first evaluation, so guard on _sass being unset.
    if (!this._sass && typeof require === 'undefined') {
      globalThis.require = (name) => {
        if (name === 'url') return { pathToFileURL: (p) => new URL('file://' + p), fileURLToPath: (u) => u.pathname, URL, URLSearchParams };
        if (name === 'fs' || name === 'path') return {};
        throw new Error('require not stubbed for: ' + name);
      };
    }
    if (!this._sass) this._sass = import(`${ESM_SH}/sass@${this.versions.sass}`);
    const sass = await this._sass;
    return (await sass.compileStringAsync(src, { url: new URL('vfs:' + path), importers: [this._sassImporter()] })).css;
  }

  /** Auto-inject provider shims into main.ts (source-level): VFS HttpInterceptor +
   *  provideHttpClient, and a MemoryLocationStrategy so the Router never touches the
   *  HOST URL (the srcdoc iframe shares the parent's location — PathLocationStrategy
   *  would pushState on the host's history). */
  _injectShims(src) {
    const shims = `
const { HTTP_INTERCEPTORS, HttpResponse, provideHttpClient, withInterceptorsFromDi } = require('@angular/common/http');
const { LocationStrategy, APP_BASE_HREF } = require('@angular/common');
const { of } = require('rxjs');
class VfsHttpInterceptor {
  intercept(req, next) {
    const assets = window.__NG_VFS_ASSETS__ || {};
    let u = String(req.url).split('?')[0];
    if (u.startsWith('/')) u = u.slice(1);
    const hit = assets[u] || assets['src/' + u] || assets['assets/' + u];
    if (hit) {
      let body = hit.content;
      try { body = JSON.parse(body); } catch (e) { /* pass through as string */ }
      return of(new HttpResponse({ status: 200, body }));
    }
    return next.handle(req);
  }
}
class MemoryLocationStrategy extends LocationStrategy {
  constructor() { super(); this._path = '/'; this._stack = ['/']; this._i = 0; this._listeners = []; }
  path() { return this._path; }
  prepareExternalUrl(internal) { return internal; }
  pushState(s, t, url) {
    this._stack = this._stack.slice(0, this._i + 1);
    this._stack.push(url || '/');
    this._i++;
    this._path = url || '/';
  }
  replaceState(s, t, url) { this._path = url || '/'; }
  forward() { if (this._i < this._stack.length - 1) { this._i++; this._move(this._stack[this._i]); } }
  back() { if (this._i > 0) { this._i--; this._move(this._stack[this._i]); } }
  /* Notify the Router's location listener ONLY on back/forward — pushState/replaceState
     were initiated BY the router, so re-navigating there would loop. */
  _move(p) {
    this._path = p;
    for (const fn of this._listeners) { try { fn({ pop: true, type: 'popstate', state: null }); } catch (e) {} }
  }
  onPopState(fn) { this._listeners.push(fn); return () => {}; }
  getBaseHref() { return '/'; }
  getState() { return null; }
}
const SHIM_PROVIDERS = [
  provideHttpClient(withInterceptorsFromDi()),
  { provide: HTTP_INTERCEPTORS, useClass: VfsHttpInterceptor, multi: true },
  { provide: LocationStrategy, useFactory: () => new MemoryLocationStrategy() },
  { provide: APP_BASE_HREF, useValue: '/' },
];
`;
    const m = src.match(/bootstrapApplication\s*\(/);
    if (!m) return shims + src;
    /* Balanced-paren scan — the config object can hold nested parens (e.g.
       provideRouter(routes)); a naive `([^)]*)` regex would truncate at the first `)`. */
    let depth = 1, i = m.index + m[0].length;
    while (depth > 0 && i < src.length) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
    const args = src.slice(m.index + m[0].length, i - 1).trim();
    const c = args.indexOf(',');
    const rest = src.slice(i);
    if (c === -1) return shims + src.slice(0, m.index) + `bootstrapApplication(${args}, { providers: SHIM_PROVIDERS })` + rest;
    const comp = args.slice(0, c).trim();
    const cfg = args.slice(c + 1).trim();
    return shims + src.slice(0, m.index) +
      `bootstrapApplication(${comp}, { ...(${cfg} || {}), providers: [...(${cfg}.providers || []), ...SHIM_PROVIDERS] })` +
      rest;
  }

  /** templateUrl -> template: require(...); styleUrl(s) -> styles: [require(...)]. */
  _inlineResources(src) {
    src = src.replace(/templateUrl\s*:\s*["']([^"']+)["']/g, (_m, p) => `template: require(${JSON.stringify(p)})`);
    src = src.replace(/styleUrls\s*:\s*\[([^\]]*)\]/g, (_m, inner) => `styles: [${inner.replace(/["']([^"']+)["']/g, (_m2, p) => `require(${JSON.stringify(p)})`)}]`);
    src = src.replace(/styleUrl\s*:\s*["']([^"']+)["']/g, (_m, p) => `styles: [require(${JSON.stringify(p)})]`);
    return src;
  }

  _findAsset(path, assets) {
    for (const p of [path, path.replace(/^\.\//, ''), 'src/' + path.replace(/^\.\//, ''), 'assets/' + path.replace(/^\.\//, '')]) {
      const a = assets[p];
      if (a && a.blobUrl) return a.blobUrl;
    }
    return null;
  }

  _rewriteTemplateAssets(html, assets) {
    return html.replace(/(src|href)="((?:\.\/)?(?:assets|src\/assets)\/[^"]+)"/g, (_m, attr, p) => {
      const b = this._findAsset(p, assets);
      return b ? `${attr}="${b}"` : _m;
    });
  }

  _rewriteCssAssets(css, assets) {
    return css.replace(/url\((["']?)((?:\.\/)?(?:assets|src\/assets)\/[^"')]+)\1\)/g, (_m, q, p) => {
      const b = this._findAsset(p, assets);
      return b ? `url(${q}${b}${q})` : _m;
    });
  }

  /* -------------------------------------------------------- sandbox iframe */

  /** The runner as an external blob: script — avoids unsafe-inline in the host CSP. */
  _getRunnerUrl() {
    if (!this._runnerUrl) this._runnerUrl = URL.createObjectURL(new Blob([RUNNER_SOURCE], { type: 'text/javascript' }));
    return this._runnerUrl;
  }

  _ensureFrame() {
    if (this.frame && this.frame.isConnected) return this.frame;
    this.frame = document.createElement('iframe');
    this.frame.className = 'ng-builder-frame';
    this.frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
    this.frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
    /* srcdoc (NOT a data: URL): inherits the host origin (so host-created blob: URLs
       are loadable) and the host CSP. The runner is an external blob: script, so no
       unsafe-inline is needed; 'unsafe-eval' must be present in the host script-src
       (or in a policy inherited by the iframe) for the CJS wrapper + Angular JIT. */
    const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<script src="${CDN}/zone.js@${this.versions['zone.js']}/bundles/zone.umd.js"><\/script>
<script src="${CDN}/reflect-metadata@${this.versions['reflect-metadata']}/Reflect.js"><\/script>
</head><body><script src="${this._getRunnerUrl()}"><\/script></body></html>`;
    this.frame.srcdoc = html;
    this.container.appendChild(this.frame);
    window.addEventListener('message', this._onFrameMessage);
    return this.frame;
  }

  _sendToFrame(payload) {
    this.frame.contentWindow.postMessage(payload, '*');
  }
}

export default AngularBrowserBuilder;