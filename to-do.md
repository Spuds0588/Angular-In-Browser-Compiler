# to-do.md — V1 build checklist

Tracked against the PRD task list. Checked = done in V1. `(deferred)` = consciously cut for
YAGNI, with a note on when to revisit.

## Phase 1: Core API shell
- [x] Vanilla JS / ESM project structure (single drop-in library, no build)
- [x] `AngularBrowserBuilder` class: constructor, `setFiles`, `updateFile`, `deleteFile`, `getFile`, `on`
- [x] Event emitter: `on('compileError' | 'success' | 'runtimeError' | 'log')`
- [x] Structured JSON logging: `[AngularBuilder::Domain] message { data }`; entries have `{ts, level, domain, message, data}`

## Phase 2: VFS & module loader
- [x] In-memory `files` Map (incremental updates; full rebuild each time — caching deferred, see agent.md)
- [x] Synchronous `require` (runner side): relative `./` `../`, extension fallback `.js`/`.ts`/`.tsx`/`index.*`
- [x] Asset modules (`.html`/`.css`/`.json`) export raw content strings via `module.exports = <json-string>`
- [x] File deletion (removes from map; next rebuild drops the module)

## Phase 3: Transpiler pipeline
- [x] Official TypeScript compiler API loaded from jsdelivr (UMD, host-side)
- [x] JIT options: `experimentalDecorators`, `emitDecoratorMetadata`, `module: CommonJS`, `target: ES2020`
- [x] Regex inliner: `templateUrl` → `template: require(...)` (key trick — JIT would fetch URLs otherwise)
- [x] Regex inliner: `styleUrl`/`styleUrls` → `styles: [require(...)]`

## Phase 4: Dependency management
- [x] Regex pre-fetcher (static + dynamic import patterns) from `.ts` sources
- [x] esm.sh DEFAULT mode (no `?bundle&external=` — it keeps bare specifiers needing an import map); esm.sh rewrites cross-package imports to absolute pinned URLs
- [x] Version pinning (`@angular/*@17.3.12`, `rxjs@7.8.1`, `tslib@2.6.3`) incl. `?deps=` for hashed rxjs/tslib dedup; subpath form `pkg@ver/sub` (scope glued)
- [x] Dedup by package:version → canonical single-copy URLs, cached globally (session)

## Phase 5: Execution & sandbox mounting
- [x] Sandboxed iframe (`allow-scripts allow-forms allow-same-origin`) with `srcdoc` document inheriting host CSP; runner as external blob: script (⚠️ `data:` docs are NOT CSP-immune in this Chromium — verified empirically; srcdoc + inherited CSP + `'unsafe-eval'` confined to sandbox is the scheme)
- [x] zone.js + reflect-metadata injected into iframe doc before app code
- [x] postMessage pipeline: host compiles → iframe imports vendor namespaces (compiler FIRST, sequentially — JIT facade race) → CJS module graph executes → Angular JIT bootstrap
- [x] App teardown on rebuild: destroy `window.__NG_APP_REF__` or iframe `location.reload()` fallback

## Phase 6: Angular compatibility layer
- [x] Auto-injected `HttpInterceptor` (VFS-backed `HttpClient`) + `provideHttpClient` merged into `bootstrapApplication` config
- [x] Blob URL generator + HTML/CSS regex replacer for `assets/` refs
- [x] `window.process = { env: { NODE_ENV: 'development' } }` shim in iframe
- [x] `MemoryLocationStrategy` for Router (auto-injected into `bootstrapApplication` config) + `APP_BASE_HREF: '/'` shim; Router demo with `provideRouter`, `RouterLink`/`RouterLinkActive`/`RouterOutlet`, and back/forward via the memory strategy's popstate listeners. Verified: navigation, active states, host URL never changes.

## Phase 7: SCSS
- [x] Lazy Dart Sass (`esm.sh/sass@1.86.3` default mode, `compileStringAsync`) on first `.scss`, with `globalThis.require` stub installed before first import (esm.sh shim calls `require('url')`)
- [x] Verified in browser: `$brand` var compiles; computed style reflects it
- [x] Custom Sass importer (`canonicalize`/`load` on a `vfs:` scheme) so `@import`/`@use`
  resolves against VFS files: partial-first resolution (`_name.scss`), `_index.scss`
  dirs, relative (`./`, `../`), and root-relative bare specifiers. Demo shares
  `src/app/_variables.scss` between `app.component.scss` and `home.component.scss`.
  Verified: both components' computed styles pull from `$brand`/`$nav-bg`/`$muted`;
  missing imports surface as clean sass errors caught by the error boundary.
- [x] npm-package Sass resolution (`npm:` scheme): bare specifiers like
  `@use '@angular/material' as mat` resolve through the package's `exports` map
  (`sass` condition → `style`/`default` → classic `sass`/`style` fields → `_index.scss`
  probe). Transitive packages (MDC `@material/*`) get their version from the
  CONSUMING package's `package.json` dependencies. A cached `data.jsdelivr.com` file
  tree per package resolves candidate probes locally and prefetches all `.scss` in
  parallel. Demo: `$brand` = `mat.get-color-from-palette(mat.$indigo-palette, 500)`
  → `#3f51b5` verified via computed style.

## Phase 8: State management & error boundaries
- [x] Last-known-good preserved on compile error (iframe untouched; structured `compileError`; host checks TS `diagnostics` BEFORE sending — `transpileModule` emits broken output on syntax errors)
- [x] Structured `runtimeError` postMessage from iframe (bootstrap catch + `window.onerror`)
- [x] Soft reload on TS edits (state resets, no host refresh)
- [x] **CSS/SCSS Fast Refresh (state preservation)** — a rebuild whose only changes are
  stylesheets recompiles them and patches the live `<style>` nodes in the sandbox instead of
  re-bootstrapping: component state and the active route survive (demo `Recolor` button).
  Verified: teal/indigo `$brand` swap with the counter and route preserved, count preserved
  across two consecutive patches, an appended rule + nested `@media` both applied, and the
  patched CSS inherited by the next soft reload. Falls back to a soft reload when a sheet
  cannot be matched to a live node. See history.md session 6 for the shim/`%COMP%` details.
- [ ] **HTML (template) Fast Refresh** — (deferred, blocked: Angular 17.3.12 exposes no HMR
  metadata API — `ɵɵreplaceMetadata` is absent from `@angular/core@17.3.12`, so a live
  component's template cannot be swapped. Template edits soft-reload. Revisit on Angular
  18+/19+, where the CLI's HMR support lands.)

## Phase 9: LLM Bridge (V2)
- [x] `window.__NG_BUILDER_MCP__` — exposed by the constructor (opt out with `{ mcp: false }`)
- [x] `readVFS()` → `{ 'src/main.ts': '...' }` (a plain object copy of the VFS map)
- [x] `patchFiles(files)` → `batch()` (one rebuild for N edits) and returns a promise that
  resolves when that build settles, so an agent never polls
- [x] `getStructuredLogs()` → the `{ts, level, domain, message, data}` entries of the LATEST
  compilation cycle (`log()` appends to `_cycleLogs`; `rebuild()` rotates to `_lastCycleLogs`)
- [x] `inspectDOM(selector?, maxDepth?)` → JSON `{tag, attrs, text, children}` tree of the
  sandbox DOM, script/style/link filtered, depth-capped + 2000-node budgeted
- [x] `whenIdle(timeoutMs?)` → `{status: 'ok'|'error'|'timeout'}` (also `builder.whenIdle()`)
- [x] Demo **Agent (MCP)** button: readVFS → patchFiles → await → inspectDOM, printed as one
  log line; verified by the e2e suite (11 MCP assertions).

## Phase 10: Verification tooling
- [x] Committed e2e harness (`test/e2e.mjs` — plain Node + Chrome DevTools Protocol, no test
  framework) covering the whole surface: **44 assertions** (bootstrap, Material-derived
  Sass, VFS assets via HttpInterceptor, Router with the host URL untouched, style fast
  refresh incl. an appended rule + nested `@media`, the unmatched-sheet fallback, the
  compile-error boundary + recovery, the V2 MCP bridge incl. the demo's Agent button,
  uncaught-error and console-error checks).
- [x] Committed demo server (`scripts/serve.mjs`) — replaces the throwaway `/tmp` one; serves
  the repo root so `demo/` can import `../src`.
- [x] `npm run serve` / `test` / `test:headed` / `test:live` (deployed Pages origin) / `lint`
  (`node --check`). CI runs lint + e2e on every push and PR (`.github/workflows/ci.yml`).

## Known gaps / next steps
- Global `styles.css` from angular.json is not supported (components' styles only)
- Template refs to non-asset URLs (e.g. `http://...`) left as-is
- esm.sh CSS imports in third-party bundles can break `import()` (MIME); framework set unaffected
- Router verified end-to-end (session 3): navigate, active states, back/forward, host URL untouched. `MemoryLocationStrategy` back/forward only works through in-app triggers (links, `Location.back()`) — browser back-button won't drive it (by design: it must never touch the host history)
- `globalThis.require` stub pollutes host global (sass only) — iframe-local sass or dedicated build would remove it
- ✅ Demo Apply/Fix now use `builder.batch(files)` — one build per apply (added in session 3)
- Sandbox CSP needs `'unsafe-eval'` in script-src — documented trade-off in README
- `NG0912: Component ID generation collision detected` is logged as a *warning* after soft
  reloads: Angular's JIT id registry lives on the sandbox document, so each re-bootstrap
  mints a new id for the same class. Benign (the old tree is gone); the e2e suite asserts no
  console *errors*, favicon 404 aside.
- Sass importer ambiguity (accepted): a bare `@use "variables"` tries the importing file's dir first, then VFS root — a same-named file at both levels would resolve to the dir one

## V1 status
- ✅ **Committed** (e2b006f): library + demo + agent/to-do/history docs. All Phase 1–5, 7, 8
  features verified live in Chromium (bootstrap, HMR, error boundary + recovery,
  HttpInterceptor, blob assets, SCSS with `$var`).
- ✅ **Phase 8 fast refresh**: styles/SCSS done (state-preserving, session 6); templates
  deferred with evidence (no Angular 17 HMR API).
- ✅ **Phase 9 LLM bridge (V2)**: `window.__NG_BUILDER_MCP__` done (session 8) — the PRD's
  whole Phase 9 task list is checked. Every PRD phase is now either implemented or deferred
  with a documented reason, so the remaining work is hardening/ideas rather than V1 scope.