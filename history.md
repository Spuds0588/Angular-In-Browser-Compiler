# history.md — Session log (write aggressively)

Log every decision, experiment result, and gotcha so parallel/next sessions don't redo work.

---

## 2026-09-06 — Session 1: V1 skeleton, pipeline, demo (initial build)

### Repo state
- Only commits: README/LICENSE (3a945e3) and PRD (004b84f). **No prior implementation exists.**
- Started V1 from scratch. Nothing committed; working tree left dirty on purpose.
- ✅ **V1 committed as e2b006f** (Session 2 end): library + demo + docs. 1072 insertions.

### Design decisions (read before touching the pre-fetcher)
1. **Single-file drop-in library** (`src/angular-browser-builder.js`), zero deps, no build.
   YAGNI over PRD's module-splitting task list.
2. **CSP strategy**: host never evals. TS transpiles host-side (pure computation).
   Execution happens in a sandboxed iframe (`sandbox="allow-scripts allow-forms
   allow-same-origin"` exactly as the PRD says) whose document is an **srcdoc** that
   INHERITS the host CSP. The runner is delivered as an external **blob: script** (no
   `unsafe-inline` needed), and the host CSP grants `'unsafe-eval'` + `blob:` in
   script-src — eval then only ever runs *inside* the sandbox. ⚠️ CORRECTION (Session 2):
   the original `data:` URL theory was WRONG — this Chromium enforces the parent CSP on
   `data:` documents too, and a document-level CSP meta does NOT override the inherited
   one (verified empirically with a dedicated test page). `srcdoc` + inherited CSP is the
   only workable scheme.
3. **Module format**: TypeScript → CommonJS via `ts.transpileModule`; each module wrapped in
   `new Function('exports','require','module', code)` inside the iframe. Sync `require`
   resolves relative specs against the VFS module map; bare specs hit a prebuilt
   specifier→namespace map.
4. **KEY TRICK — resource inlining**: `templateUrl: 'x'` must become `template: require('x')`
   (and `styleUrl(s)` → `styles: [require(...)]`), NOT `templateUrl: require('x')`.
   Angular JIT sees a string in the `templateUrl` slot and tries to **fetch** it via its
   resource loader → 404s. String substitution into `template`/`styles` slots is the only
   correct regex-level rewrite.
5. **esm.sh pre-fetch**: Default mode (NO `?bundle&external=`) rewrites cross-package
   imports to absolute pinned esm.sh URLs with zero bare specifiers — no import map
   needed. `?external=` keeps bare specifiers by design (consumer must supply an import
   map; an inline one would be CSP-blocked). The iframe does `import(url)` (namespaces
   are NOT postMessage-able, so vendor modules must be imported inside the iframe).
   External list = the constructed esm.sh URLs themselves, deduped by package:version
   (esm.sh absolute rewriting guarantees single copies). **A duplicated `@angular/core`
   breaks DI at runtime** — also mind esm.sh's `?deps=rxjs@7.8.1,tslib@2.6.3` pinning so
   hashed rxjs/tslib URLs match what the Angular bundles reference.
   ⚠️ Scoped-package gotcha: `'@angular/common/http'.split('/')` gives
   `['@angular','common','http']` — build the URL as `pkg@ver/sub` where the scope stays
   glued: `@angular/common@17.3.12/http` (esm.sh subpath form), never `@angular@17.3.12/...`
   nor `@angular/common/http@17.3.12` (404s).
   ⚠️ Version pinning is mandatory: an unpinned `@angular/common/http` import resolved to
   v22 and broke the app.
6. **HMR (V1)**: every edit → full re-transpile + re-bootstrap in the iframe (soft reload,
   state resets). Runner destroys `window.__NG_APP_REF__` if the app set it, else
   `location.reload()` inside the iframe. Host page never reloads. HTML/CSS fast refresh
   (state preservation) deferred — needs Angular template-cache clearing research.
   ⚠️ Each `updateFile` call triggers one build — editing N files then calling
   `updateFile` N times fires N builds. Fine for a demo; a `batch(files)` API is a future
   nicety (the demo's Apply button double-builds today).
7. **HttpInterceptor**: injected into `main.ts` as source text before transpile:
   `provideHttpClient(withInterceptorsFromDi())` + `HTTP_INTERCEPTORS` multi-provider merged
   into the app's `bootstrapApplication` config (supports config-object or bare-component
   form). Interceptor reads `window.__NG_VFS_ASSETS__` set by the runner; returns
   `of(new HttpResponse(...))` with JSON-parsed body; misses fall through to the network.
   ⚠️ Angular 15+: DI-based `HTTP_INTERCEPTORS` is IGNORED unless
   `withInterceptorsFromDi()` is present — a plain `provideHttpClient()` silently drops
   the interceptor.
8. **Assets**: text/data-URL assets → `URL.createObjectURL` on the host (srcdoc + same-
   origin iframe can load host blob URLs — an opaque-origin `data:` doc gets
   "Not allowed to load local resource", another reason srcdoc won). Template
   `src/href="assets/..."` and CSS `url(assets/...)` rewritten to blob URLs at compile
   time. Lookup tries `assets/…` and `src/assets/…` (request path is `assets/data.json`
   while the VFS key is `src/assets/data.json`). Binaries must be supplied as `data:`
   URLs in V1.
9. **Zone.js + reflect-metadata** are script-tagged into the iframe doc (jsdelivr UMD),
   before the runner. `@angular/compiler` is in the ALWAYS-IMPORTED set (first, before the
   other externals) — Angular 17's JIT resolves the compiler facade via `window.ng` when
   the compiler module executes (`mA(globalThis)`), and `ɵɵngDeclareInjectable` static
   blocks run DURING module evaluation, so the compiler must be registered SEQUENTIALLY
   first, not raced in a `Promise.all`.

### Test log (preview Chromium, host page served as static file)
- Demo app (standalone component, AsyncPipe, HttpClient fetch of `assets/data.json`,
  PNG from VFS) boots and renders inside the sandboxed iframe. ✓
- Strict host CSP meta (no unsafe-eval/unsafe-inline in host-authored code) present the
  whole time; bootstrap succeeded inside the srcdoc iframe. ✓
- Structured logs stream to the host; console shows `[AngularBuilder::…]` entries. ✓
- **HttpInterceptor**: `<p>Data: Hello from VFS JSON…</p>` rendered — VFS asset served
  through `HttpClient` without network. ✓ (after `withInterceptorsFromDi()` fix)
- **HMR TS edit**: changed component text → iframe re-bootstrapped, DOM updated, count
  reset (expected soft-reload semantics). ✓
- **Error boundary**: injected a TS syntax error → `compileError` event with structured
  payload; iframe kept rendering the last-good build. Restored → app rebuilt. ✓
- **SCSS**: swapped component to a `.scss` styleUrl → Dart Sass (lazy-loaded) compiled
  `$brand` var; `h1` color verified via computed style. ✓

### Session 2 additions (same date): CSP, pre-fetch, interceptor, error-boundary fixes

#### CSP rework (the big one)
- **Empirical test** (`csp-test.html` + a second page): in THIS Chromium, a `data:` doc
  inherits the parent CSP (inline script refused), and its own document-level CSP meta
  does NOT override the inherited one. The history.md claim that data: docs are
  CSP-immune was wrong; deleted the test pages after the fix landed.
- Final scheme: `srcdoc` iframe inheriting the host CSP, runner as external blob: script,
  host CSP = `script-src 'self' <cdns> blob: 'unsafe-eval'`. `'unsafe-eval'` is granted
  globally but only the sandbox ever evaluates (runner wraps CJS in `new Function`;
  Angular JIT needs it too) — matches PRD intent that the host's own code never evals.
- Gotchas hit along the way: blob: script in a `data:` doc → "Not allowed to load local
  resource" (opaque origin); `allow-same-origin` + srcdoc → iframe inherits host origin
  so host blob: URLs load; Chrome warns that allow-scripts+allow-same-origin can escape
  sandboxing (acceptable: the sandbox is the PRD's execution boundary, not a security
  boundary against the trusted host page).

#### Pre-fetch rework (import-map trap)
- `?bundle&external=` keeps BARE specifiers by design (esm.sh docs) — the consumer must
  resolve them via an import map, which an inline map would need `unsafe-inline` for.
  Switched to DEFAULT mode: esm.sh rewrites cross-package imports to absolute pinned
  URLs (zero bare specifiers) — no import map at all.
- rxjs dedup: default mode resolves rxjs to `^7.8.2` while we pinned `7.8.1` → two
  rxjs instances break `instanceof Observable`. Fixed by `?deps=rxjs@7.8.1,tslib@2.6.3`
  on the constructed URLs so hashed URLs match.

#### JIT facade ordering
- Angular 17 core emits `ɵɵngDeclareInjectable` static blocks during module evaluation;
  JIT needs `window.ng` compiler facade, registered when `@angular/compiler` executes.
  Racing all externals in `Promise.all` lost the race. Fix: import the compiler FIRST,
  await it, then import the rest in parallel.

#### Error boundary hardening
- `ts.transpileModule` EMITS output even with syntax errors (only `diagnostics` reports
  them) → the broken build reached the sandbox, destroyed last-good, then `new Function`
  threw. Fix: check `diagnostics` in the host and throw a structured `compileError`
  BEFORE sending anything to the iframe.

#### SCSS lazy-load (require-stub)
- sass browser builds are cli_pkg bundles; esm.sh's injected shim calls `require('url')`
  at load time. In a fresh document, installing `globalThis.require` (returning a tiny
  `url`/`fs`/`path` stub) BEFORE the first `import()` satisfies it and
  `compileStringAsync` works. Demo-page failures were stale-module pollution from
  earlier classic-script loads (`_cliPkgExports` redeclared) — a full page reload
  cleared it.
- Also: `?bundle` of sass trips a Node `url` shim at ANY version; default mode serves
  the browser build (works with the require stub).

### Gotchas that cost time (do not repeat)
- Putting the runner logic inside a template literal broke on nested backticks — the runner
  is now a standalone function serialized with `fn.toString()`. It must stay closure-free.
- First version of the pre-fetcher fetched framework deps with mismatched external lists →
  two copies of `@angular/core` → cryptic DI runtime errors. The identical-external-list
  rule (decision 5) fixed it (now moot — default mode dedupes by construction).
- Sending bootstrap before the iframe doc parsed dropped the message → gate bootstrap on the
  runner's `ready` postMessage for the first build; subsequent builds can send immediately
  (messages queue once a handler exists).
- `sass` package browser build only supports async compile — use `compileStringAsync`,
  never `compileString`.
- esm.sh URL forms: subpath packages are `pkg@ver/sub`; scoped names must keep the scope
  glued to the package (`@angular/common@17.3.12/http`). Pin EVERYTHING (`@angular/*`
  resolved to v22 once when unpinned).
- Angular 15+ requires `withInterceptorsFromDi()` or DI interceptors silently don't run.
- `ts.transpileModule` emits broken output on syntax errors — ALWAYS check diagnostics.
- The runner must register `@angular/compiler` facade BEFORE other `@angular/*` modules
  evaluate (sequential first import), not in `Promise.all`.
- Don't trust module-cache state across hot page reloads when debugging CDN modules —
  reproduce in a fresh document before changing library code.

### Session 2 finale — full re-verification & commit
- Fresh page load, then complete feature sweep in one session: bootstrap ✓, HMR TS edit
  (title changed, count reset, interceptor intact) ✓, error boundary (break → compileError,
  last-good kept) ✓, recovery ✓, HttpInterceptor ✓, blob PNG ✓, SCSS `$brand` var ✓.
- Committed everything (e2b006f). Only untracked item left: `.freebuff/` (tooling metadata).
- SCSS root-cause recap: the require-stub fix was correct all along; the demo-page failures
  were pollution from earlier test script loads — verify CDN-module behavior in a FRESH
  document before touching library code.

## 2026-09-07 — Session 3: Router support (Phase 6) + batch() API

### What landed (all verified live in Chromium)
- **Auto-injected `MemoryLocationStrategy` + `APP_BASE_HREF: '/'`** in `_injectShims`, plus
  a Router demo (`provideRouter`, shell + Home/About routes, `RouterLink(Active)`/`RouterOutlet`).
  Verified: bootstrap, link navigation, active-link classes, `Location.back()` re-render,
  routed component teardown on nav, host URL never changes.
- **`builder.batch(files)`** — atomic multi-file update, ONE build. Demo Apply/Fix now use it
  (the old double-build is gone).
- **Root-element injection cleanup**: `rebuild()` now skips selectors used as tags in
  templates, and when a template has `<router-outlet` only the first selector (the shell)
  is pre-created — no more phantom empty `<app-home>`/`<app-about>` skeletons in the DOM.
- **`_injectShims` balanced-paren scan**: the old `bootstrapApplication\s*\(([^)]*)\)` regex
  truncates at the first `)` — breaks any config with nested parens like
  `provideRouter(routes)`. Replaced with a depth-counting scan.

### The Router debugging saga (do not repeat)
- **Symptom**: `NG04002: Cannot match any routes. URL Segment: 'srcdoc'` — the Router's
  initial URL was `about:srcdoc`'s pathname. Root cause (forensic, ~1h): `useClass` on an
  UNDECORATED class in the shim. `LocationStrategy` in @angular/common is
  `@Injectable({providedIn: 'root', useFactory: () => inject(PathLocationStrategy)})`, and
  Angular's inherited-factory fallback (`wI` in core.mjs) walks the CONSTRUCTOR prototype
  chain: `MemoryLocationStrategy.ɵfac/ɵprov` resolves to `LocationStrategy`'s — so
  `useClass: MemoryLocationStrategy` silently instantiated via the INHERITED ɵprov factory
  → **PathLocationStrategy**, with the deprecation warning
  ("instantiates a token that inherits its @Injectable decorator") as the telltale.
  **Fix: `{ provide: LocationStrategy, useFactory: () => new MemoryLocationStrategy() }`**
  — `useFactory` bypasses the inherited lookup entirely. (Alternative: `@Injectable()` on
  the shim class.)
- **Second bug**: `Location.getState()` — Angular 17's `Location` calls
  `strategy.getState()` for router `restoredState` during initial navigation. Add
  `getState() { return null; }`.
- **Third bug**: `Location.back()` changed the strategy's path but the Router never knew
  (no popstate). Fixed by storing the `onPopState` listener and firing it (with a synthetic
  `{pop:true,type:'popstate'}` event) ONLY in `back()`/`forward()` — never in
  pushState/replaceState (those are router-initiated; notifying would loop).
- **DI duplicate-token rule verified empirically**: same injector, LAST provider wins.
  `provideRouter` (v17) provides NO LocationStrategy; the default Path comes from
  `LocationStrategy`'s own providedIn:root factory — so the app injector gets the strategy
  even with zero router setup, and our shim must override it explicitly.
- **Debugging technique that paid off**: `inj.records` (Map token→record) on the app
  injector + `inj.parent` chain; `instanceof` checks against `mod.PathLocationStrategy`;
  minified classes make `constructor.name` useless ('t' = both LocationStrategy AND
  PathLocationStrategy in common.mjs).

### Session 3 finale — full regression sweep (all ✓)
bootstrap → Home (interceptor data) → +1 ×2 (count 2) → About (active class, host URL
unchanged) → `Location.back()` (Home re-renders, About destroyed) → HMR title edit
(re-boot, count reset, router still navigates) → break (compileError, last-good kept) →
fix (recovery) → SCSS `$brand: #7c3aed` (h1 + active link colors verified, router intact).

---

### Open questions for next sessions
- Does esm.sh rewrite the dynamic `import('@angular/compiler')` or did the eager framework
  import mask it? (Check by removing compiler from the always-imported set.)
- Router: `MemoryLocationStrategy` + `APP_BASE_HREF` + `provideRouter` — needs a Router
  demo before claiming Phase 6.
- SCSS `@import`/`@use` of VFS files: custom sass importer pending.
- `globalThis.require` stub pollutes the host global — acceptable for V1; a dedicated
  esm.sh build or an iframe-local sass worker would remove it.
- The demo Apply button double-builds (two `updateFile` calls) — consider `batch(files)`.