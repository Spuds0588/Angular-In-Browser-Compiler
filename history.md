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

### Session 3 addendum — deploy & live verification
- Pushed to GitHub (`Spuds0588/Angular-In-Browser-Compiler`), enabled GitHub Pages via
  Actions (`build_type=workflow`), site: https://spuds0588.github.io/Angular-In-Browser-Compiler/
  (root `index.html` redirects to `./demo/`).
- **Deploy gotcha**: publishing ONLY `demo/` broke the page — `controls.js` imports
  `'../src/angular-browser-builder.js'`, so `src/` 404'd and the module graph died
  (status stuck at `idle`, no console error other than a 404). Fix: publish the whole
  repo root + a root redirect index. The builder import MUST resolve from the demo dir.
- Verified the LIVE site with headless Chrome (`google-chrome-stable --headless=new`
  driven over CDP with the `ws` npm package — Node 20 has no global WebSocket, and
  `--dump-dom --virtual-time-budget` exits before the async esm.sh bootstrap). Fresh
  `--user-data-dir` per run is mandatory — a stale profile served cached 404s and
  misled two debug runs. All green on Pages: boot, HttpInterceptor data, +1, About
  navigation + active class, host URL stays on github.io (MemoryLocationStrategy).
- Node v20 note: global `WebSocket` requires v22+; use `ws` from a scratch npm dir.

### Session 3 finale — full regression sweep (all ✓)
bootstrap → Home (interceptor data) → +1 ×2 (count 2) → About (active class, host URL
unchanged) → `Location.back()` (Home re-renders, About destroyed) → HMR title edit
(re-boot, count reset, router still navigates) → break (compileError, last-good kept) →
fix (recovery) → SCSS `$brand: #7c3aed` (h1 + active link colors verified, router intact).

---

## 2026-09-08 — Session 4: custom Sass importer (VFS @import/@use) + shared _variables.scss

### What landed (all verified live in Chromium)
- **`_sassImporter()`** in the builder: a `canonicalize`/`load` importer over a `vfs:`
  scheme, wired into `compileStringAsync(src, { url, importers })` (the `url` option is
  required — it gives sass the containing file for relative resolution).
- **Resolution order** (dart-sass partial convention): `name.scss` → `name.sass` →
  `_name.scss` → `_name.sass` → `name/_index.scss` → `name/index.scss`; `@use "variables"`
  resolves against the importing file's dir FIRST, then VFS root (bare-specifier
  convenience, no node_modules). Root-relative (`@use "src/app/_variables.scss"`) and
  `../` escapes work too. Missing imports → clean sass error → error boundary keeps
  last-good.
- **Demo**: new `src/app/_variables.scss` (`$brand: #7c3aed`, `$nav-bg`, `$text`, `$muted`,
  …); `app.component.scss` + `home.component.scss` both `@use './variables'` with
  `variables.$x` namespacing. Verified computed styles: h1 + active link = $brand,
  nav bg = $nav-bg, hint = $muted.

### The importer API contract (do not repeat)
- **sass strips `./` before calling the importer** — `@use "./variables"` arrives at
  `canonicalize` as `"variables"`, and `@use "./sub/variables"` as `"sub/variables"`.
  The containing file comes via the `context.containingUrl` (the `url` option you passed
  to compileStringAsync). This is IDENTICAL for opaque (`vfs:src/...`) and hierarchical
  (`vfs:///src/...`) schemes — don't bother switching schemes; resolve the string against
  `containingUrl` yourself.
- Path-normalize the joined string (drop `.`/`..` segments) BEFORE matching VFS keys —
  `src/app/./variables` silently misses every key. First bug found this way.
- The importer's `load()` returns `{ contents, syntax }`; syntax `'indented'` for `.sass`.
  `canonicalize` returning `null` = "let sass fall through" (https: etc.).

### Full sweep after the change (all ✓)
bootstrap → SCSS vars on h1/nav/hint → importer edge cases (../ escape, bare root,
missing → clean error) → +1 → About nav + host URL untouched → HMR edit (title change,
count reset, interceptor intact) → break (compileError, last-good kept) → fix (recovery,
SCSS intact).

### Deploy
Pushed (a2d9769) → Pages workflow auto-deployed → headless-Chrome CDP check against the
LIVE github.io site: boot, h1=`$brand` (rgb(124,58,237)), hint=`$muted`, nav bg=`$nav-bg`,
Home/About nav + active class, host URL stays on github.io. The importer behaves
identically in production.

---

## 2026-09-08 — Session 5: npm-package Sass resolution (@use '@angular/material')

### What landed (all verified in Chromium)
- **`npm:` scheme in `_sassImporter()`**: bare specifiers (`@use '@angular/material' as mat`)
  resolve through the package's `package.json` `exports` map — `sass` condition first
  (material: `.` → `./_index.scss`), then `style`/`default` conditions, then classic
  `sass`/`style` fields, then an `_index.scss` probe. Subpaths (`@material/x/sub`)
  probe directly as files in the package root. Version comes from the pinned `versions`
  map; when the `@use` is INSIDE another package, from that package's `dependencies`
  (MDC transitive case).
- **Demo**: `_variables.scss` now does `@use '@angular/material' as mat;` and derives
  `$brand: mat.get-color-from-palette(mat.$indigo-palette, 500)` → computed h1 color
  `rgb(63, 81, 181)` = `#3f51b5`. Full sweep green: bootstrap, +1, About/Home nav +
  exclusive active classes, host URL untouched, HMR edit (title changed, count reset,
  material color recompiled from cache).

### Gotchas that cost time (do not repeat)
- **sass strips `./` from EVERY scheme** — inside a package file, `@forward './core/theming/theming'`
  arrives as `core/theming/theming`, indistinguishable from a package name. Rule: inside
  `npm:` context, scoped specifiers (`@scope/pkg`) are ALWAYS packages; unscoped ones try
  RELATIVE first, then package. Failing to do this sent `core/theming/theming` to
  package resolution and broke the entry forward.
- **Partial probing must be partial-FIRST** (`name.scss` → `_name.scss` → `name/_index.scss`),
  exactly like the VFS branch — `@forward './core/theming/theming'` lives at
  `core/theming/_theming.scss`, and treating `theming` as a directory misses it.
- **Transitive MDC versions**: material's scss `@use`s `@material/*` at
  `15.0.0-canary.7f224ddd4.0` (canary!). MDC packages have NO `exports` map and NO
  `sass` field — the classic `_index.scss` fallback + subpath probing is what makes
  `@material/feature-targeting/feature-targeting` resolve. Version must come from the
  CONSUMING package's package.json dependencies, not the `versions` pin map.
- **jsdelivr file tree** (`data.jsdelivr.com/v1/packages/npm/<pkg@ver>`) returns paths
  RELATIVE to the package root (no `pkg@ver/` prefix) — strip the prefix before
  `Set.has()`. One request per package; use it to (a) resolve all candidate probes
  locally (no 404 round-trips) and (b) prefetch every `.scss`/`.sass` in parallel
  (6 workers) so dart-sass's sequential `load()` calls hit the cache. First compile of
  the full material graph ≈ 35 s (warm), near-instant thereafter (HTTP + JS caches).
- **CSP**: `connect-src` needs `https://data.jsdelivr.com` added (demo/index.html).
- **Pre-existing demo bug found + fixed**: `routerLink="/"` prefix-matches EVERY route,
  so Home and About were BOTH `active`. Fixed with
  `[routerLinkActiveOptions]="{ exact: true }"` on the Home link.

### Deploy
Pushed (57d20d7) → Pages auto-deployed → headless-Chrome CDP check against the LIVE
github.io site: boot, h1 = Material `$brand` (rgb(63,81,181) = indigo-500), hint/nav bg
VFS tokens intact, About nav + exclusive active class (exact-match fix), host URL stays
on github.io. The npm-package Sass importer behaves identically in production; first
compile on the live origin ≈ 45 s, cached thereafter.

---

## 2026-09-15 — Session 6: HTML/CSS Fast Refresh (styles half) + state-preserving SCSS edits

### What landed (verified with headless Chromium over CDP)
- **Style-only fast refresh.** `rebuild()` now dispatches: when EVERY file changed since the
  last build is `.css`/`.scss` (and the app is booted with no pending error) it takes
  `_patchStyles()` instead of `_rebuildFull()` — it recompiles the stylesheets and asks the
  sandbox to swap the text of the LIVE `<style>` nodes. The app is never torn down, so
  component state AND the active route survive an SCSS/CSS edit. Logged as
  `[AngularBuilder::HMR] styles patched in place — component state preserved`.
- **`_lastStyles`** (raw CSS per path, as last handed to the sandbox) is the baseline for
  the diff; a successful patch also rewrites `lastGood.modules[path]`, so the NEXT soft
  reload inherits the patched CSS instead of reverting it. `_dirty`/`_full` track what
  changed: `setFiles`/`deleteFile` force a full rebuild, `updateFile`/`batch` are eligible
  for the fast path.
- **Demo**: new `Recolor (SCSS fast refresh)` button — flips `$brand` between
  `mat.$indigo-palette` and `mat.$teal-palette` in the shared `_variables.scss`.

### The discovery that makes it possible (do not re-derive)
- Angular shims component styles at **JIT-compile time**: the compiler turns each rule into
  `sel[_ngcontent-%COMP%]`, and platform-browser's renderer only substitutes the live id
  (`Oe(id, def.styles)` = `styles.map(s => s.replace(/%COMP%/g, id))`). Two components with
  the same stylesheet therefore produce IDENTICAL style text apart from the id — which is
  exactly what makes a live `<style>` node matchable and patchable.
- **Do not re-implement the shim.** Angular's `ShadowCss` (class `_o` in the compiler
  bundle) is NOT exported (232 exports checked). Instead, get the shimmed template from the
  JIT itself: JIT-compile a throwaway probe component in the sandbox —
  `core.Component({ selector: 'ngb-shim-probe', template: '', styles: [css] })(Probe)` — then
  read the def off `Probe['ɵcmp']` (`def.styles` is the `%COMP%` template). One probe per
  file per patch; `styles: [oldCss, newCss]` gives both templates index-aligned.
- **Matching a node**: extract the id with `/\[_ngcontent-([^\]]+)\]/` from each candidate
  `<style>`, then require `tpl.replace(/%COMP%/g, id) === node.textContent` (full-string
  equality — no markers injected into user CSS, no partial-match guesswork). Patch EVERY
  matching node (two components can share one stylesheet).
- **Fallback, not fragility**: `not-injected` when the previous CSS has no `{` (a
  variables-only partial like `_variables.scss` compiles to an empty sheet and was never
  injected) and `no-node`/`shim-failed` otherwise → the host logs a warning and re-runs the
  FULL build (soft reload). Verified by deleting the style nodes from the sandbox DOM
  before a patch: the app recovered with the new rule applied.

### Why templates still soft-reload (deferred, with evidence)
- **Angular 17.3.12 has no HMR metadata API**: `ɵɵreplaceMetadata` / `u0275replaceMetadata`
  do not exist in `@angular/core@17.3.12/es2022/core.mjs` (the minified exports were listed;
  only `ɵsetClassMetadata`, `ɵngDeclareClassMetadata`, … are present). Swapping a live
  component's template needs that API (Angular CLI HMR), so HTML edits keep the V1 soft
  reload. Revisit on Angular 18+/19+ — the styles path here is independent of it.

### Verification (headless Chromium, fresh profile, CDP; demo served statically)
boot → h1 `rgb(63,81,181)` (Material indigo-500) → interceptor JSON → About/Home nav with
host URL untouched → `+1`x3 → **Recolor → h1 `rgb(0,150,136)` (teal-500) with count STILL 3,
route still Home, `#status` still "app running", style node count 2 → 2** → soft reload (TS
edit) keeps the PATCHED teal AND resets count → second Recolor back to indigo with the 2
clicks preserved → appended `strong {}` rule + nested `@media` in home.component.scss both
apply (rgb(192,57,43), letter-spacing 2px) with count preserved → HTML edit → soft reload
(as designed) → fallback test (style nodes deleted from the DOM) → soft reload recovers →
break/fix error boundary → `console.errors === []`.

### Tooling gotchas (cost real time this session)
- `pkill -f "node /tmp/serve.js"` ALSO matches the bash process running the command (the
  pattern appears in its own command line) — it kills the shell and you lose all output.
  Get the pid from `ss -ltnp | grep <port>` instead.
- A detached static server (`setsid nohup … &`) does NOT reliably survive between commands
  here; keep the whole run in ONE command — spawn the server from the CDP harness itself
  (and use a hardcoded port: this shell has `PORT=0` in its env).
- `register_preview` with `replace: true` STOPS the pid currently registered — passing the
  same pid kills your server. Register the new server's pid once and leave it alone.
- Writing harness code through the file tools double-escapes backslashes: a `\n` inside an
  outer template literal can arrive as a REAL newline and break the inner script. Use
  `String.fromCharCode(10)` / no escapes in such scripts.
- Dev-mode `NG0912 (Component ID generation collision … 'AppComponent' and 'AppComponent')`
  fires on every soft reload — a second AppComponent is compiled with the same selector
  while the old class is still alive. Pre-existing, harmless (the old tree is destroyed).

### Open questions for next sessions
- Does esm.sh rewrite the dynamic `import('@angular/compiler')` or did the eager framework
  import mask it? (Check by removing compiler from the always-imported set.)
- `globalThis.require` stub pollutes the host global — acceptable for V1; a dedicated
  esm.sh build or an iframe-local sass worker would remove it.
- Session 6 deploy: pushed af24e72 → Pages workflow succeeded → headless-Chrome CDP check
  against the LIVE github.io demo: boot with 2 injected `<style>` nodes, h1 = Material
  `$brand` (rgb(63,81,181)), interceptor JSON, About nav with the host URL staying on
  github.io, then **Recolor → h1 teal-500 with the count preserved (2)**, host URL unchanged,
  and a following soft reload keeps the patched teal. The fast-refresh path behaves
  identically in production.
- Next PRD milestones: template fast refresh (blocked on Angular's HMR API — see session 6),
  then the V2 LLM bridge (`window.__NG_BUILDER_MCP__`).
- Style fast refresh currently recompiles EVERY stylesheet on each style-only edit (needed so
  a shared partial's dependents are picked up). Fine at this size; a reverse dependency map
  would avoid the extra sass work on larger projects.
- Sass npm resolution is eager for the full graph of `@use '@angular/material'` (every
  component theme forwards + MDC). A targeted `mat.define-theme` (M3) demo instead of
  the legacy palette API would exercise a smaller subgraph.

---

## 2026-09-15 — Session 7: committed e2e harness + CI (verification stops living in /tmp)

### What landed
- **`test/e2e.mjs`** — the whole V1 surface as **33 assertions**, in headless Chromium over
  CDP with **no test framework** (plain Node + `node:child_process`). Supersedes every
  throwaway `/tmp/cdp*/check*.mjs` from sessions 3–6, which are now redundant.
- **`scripts/serve.mjs`** — the demo's static server, committed (was `/tmp/serve.js`, which
  kept dying between turns). Serves the repo root so `demo/` can import `../src`.
- **`package.json` scripts**: `serve`, `test`, `test:headed`, `test:live` (deployed origin),
  `lint` (`node --check` over src/demo/scripts/test). **`.gitignore`**: `node_modules/`,
  `.freebuff/`.
- **CI** (`.github/workflows/ci.yml`): Node 22 + the runner's preinstalled Chrome →
  `npm run lint` + `npm test` on every push/PR. Node 22 has a global `WebSocket`, so CI
  installs nothing at all.
- `ws` is a **test-only devDependency** (Node < 22 fallback): the harness prefers
  `globalThis.WebSocket` and dynamic-imports `ws` only when absent. `src/` stays dep-free.

### Gotchas found while building it (do not re-derive)
- **`new URL('.', import.meta.url).pathname` percent-encodes spaces** — spawning with it makes
  Node look for `/home/.../Coding%20Projects/.../scripts/serve.mjs`. Use `fileURLToPath()`.
- **`window.__BUILDER__` is undefined when `#status` first appears**: `#status` is static HTML,
  so the demo's module graph may not have executed yet. `builder.getFile` then throws
  "Cannot read properties of undefined" — read `__BUILDER__` *after* the boot wait.
- **CDP `Log.entryAdded` reports `text` WITHOUT the URL** ("Failed to load resource: … 404"),
  so a `!text.includes('favicon')` filter can never match and the suite fails on the demo's
  only 404. Record `entry.url` next to `entry.text`; confirmed that url is `/favicon.ico`.
- Chrome's `--remote-debugging-port=0` + reading `DevToolsActivePort` from the profile dir
  removes CDP port collisions entirely; the **fresh temp profile per run** rule (session 4)
  still stands.

### Verification
- `npm test` → **33/33, exit 0** locally (only ignored console entry: the favicon 404).
- Pushed as `8b46575` → the new **CI workflow ran on GitHub: 33/33 in ~3.7 min** (cold
  jsdelivr fetches; a warm local run is ~2.5 min). It installs nothing — Node 22's global
  `WebSocket` is the only requirement.
- **`npm run test:live` — the full 33 checks against the deployed github.io demo: 33/33,
  exit 0.** Style fast refresh, the unmatched-sheet fallback and the error boundary all
  behave identically in production, so the suite is a valid release gate, not just a
  localhost tool.

### Open questions for next sessions
- (unchanged) template fast refresh (Angular 17 has no HMR metadata API).
- The suite asserts hardcoded demo expectations (`$brand` colours, `$nav-bg`, `$muted`,
  the interceptor payload) — changing the demo means updating those constants in
  `test/e2e.mjs`.

---

## 2026-09-15 — Session 8: V2 LLM bridge (`window.__NG_BUILDER_MCP__`)

### What landed
- **`window.__NG_BUILDER_MCP__`** — the PRD's Phase 9 list, all five methods:
  `readVFS()`, `patchFiles(files)` (= `batch` + `whenIdle`, returns a promise), 
  `getStructuredLogs()`, `inspectDOM(selector?, maxDepth?)`, `whenIdle(timeoutMs?)`.
  Set in the constructor; **`{ mcp: false }` opts out** (it is a global with VFS-write power,
  so the escape hatch matters). `builder.whenIdle()` also exists on the instance.
- **Cycle-scoped logs**: `log()` appends to `_cycleLogs`; `rebuild()` rotates
  `_cycleLogs` → `_lastCycleLogs`; `getStructuredLogs()` returns the current cycle if it has
  entries, else the previous one. That is what "last compilation cycle" means here.
- **`inspectDOM`** walks `frame.contentDocument` (same-origin srcdoc), depth-capped (12),
  2000-node budgeted, `script`/`style`/`link`/`meta` filtered, leaf text trimmed to 500 chars.
- **Demo**: `Agent (MCP)` button + `#logs li.mcp` styling — readVFS → patchFiles(shared SCSS
  token) → await → inspectDOM, printed as one line (no editor, no UI state involved).
- **e2e**: +11 MCP assertions (now **44/44**).

### Notes / gotchas
- **Don't "fix" the log asymmetry**: a style-only fast-refresh cycle contains *only* `HMR`
  entries, while a TS cycle contains `Pipeline`/`Prefetch`/`Sandbox`. The first version of the
  e2e check demanded `HMR`+`Pipeline` in one cycle and correctly failed; the useful invariant
  is "the returned logs belong to the LATEST cycle" — now asserted both ways (style cycle has
  no `Pipeline`; a following TS edit switches to `Pipeline`+`Sandbox`).
- `whenIdle` unsubscribes by deleting its handlers out of `this.listeners` (no public `off`
  added — YAGNI) and always settles, so an agent can't hang: `'timeout'` after `timeoutMs`.
- Asserted with a 1 ms timeout that the guard actually fires, rather than trusting the code.

### Verification
`npm test` → **44/44, exit 0** locally.