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
- [ ] `MemoryLocationStrategy` for Router — (deferred; add with the first Router demo — needs `provideRouter` + `APP_BASE_HREF` analysis)

## Phase 7: SCSS
- [x] Lazy Dart Sass (`esm.sh/sass@1.86.3` default mode, `compileStringAsync`) on first `.scss`, with `globalThis.require` stub installed before first import (esm.sh shim calls `require('url')`)
- [x] Verified in browser: `$brand` var compiles; computed style reflects it
- [ ] Custom Sass importer for `@import` VFS paths — (deferred; `@import`/`@use` of other VFS `.scss` files unresolved)

## Phase 8: State management & error boundaries
- [x] Last-known-good preserved on compile error (iframe untouched; structured `compileError`; host checks TS `diagnostics` BEFORE sending — `transpileModule` emits broken output on syntax errors)
- [x] Structured `runtimeError` postMessage from iframe (bootstrap catch + `window.onerror`)
- [x] Soft reload on TS edits (state resets, no host refresh)
- [ ] HTML/CSS Fast Refresh (state preservation via template-cache clear) — (deferred; V1 soft-reloads everything. Revisit with `ɵclearResolutionOfComponentResourcesQueue` research)

## Phase 9: LLM Bridge (V2)
- [ ] `window.__NG_BUILDER_MCP__` — (V2, per PRD)

## Known gaps / next steps
- Global `styles.css` from angular.json is not supported (components' styles only)
- Template refs to non-asset URLs (e.g. `http://...`) left as-is
- esm.sh CSS imports in third-party bundles can break `import()` (MIME); framework set unaffected
- Verify Router support end-to-end before claiming it (Phase 6)
- `globalThis.require` stub pollutes host global (sass only) — iframe-local sass or dedicated build would remove it
- Demo Apply button double-builds (two `updateFile` calls) — `batch(files)` nicety
- Sandbox CSP needs `'unsafe-eval'` in script-src — document the trade-off in README
- 2 commits of V1 to make (library+docs; demo+tests)