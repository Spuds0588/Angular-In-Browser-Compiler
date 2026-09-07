# agent.md — Working on this project

## What this is
A front-end-only, zero-backend, in-browser compiler + builder for Angular (v17+) apps.
Distributed as a single drop-in ESM library. See `PRD-Angular In-Browser Compiler.md` for
the full product spec; `to-do.md` for the task list; `history.md` for accumulated learnings.

## Quick start
- No build step, no deps, no Node needed for dev.
- Serve the repo root (e.g. `python3 -m http.server 8000` or any static server) and open
  `/demo/index.html`. The demo page boots a sample Angular app entirely in-browser.
- Everything is tested in a real Chromium session (the Freebuff Preview tab, or any browser).
  There is no unit-test harness yet — the demo page doubles as the smoke test.

## Architecture (V1)
Single file library: `src/angular-browser-builder.js` (pure browser ESM, no imports).

Pipeline on every `rebuild()`:
1. **VFS** — `files: Map<path, content>`; `setFiles` / `updateFile` / `deleteFile`.
2. **Pre-fetch** — regex-scan `.ts` files for external import specifiers; fetch each from
   `esm.sh`. Angular/rxjs/tslib use DEFAULT mode (all cross-package imports rewritten to
   absolute pinned URLs, `?deps=rxjs@…,tslib@…` keeps ONE shared copy — dupes break DI and
   `instanceof Observable`); user deps get `?bundle` (self-contained). `?bundle&external=`
   is FORBIDDEN: it emits bare specifiers that need an import map, and inline import maps
   are CSP-blocked. Namespaces are created by the **iframe** via `import(url)` (host can't
   postMessage module namespaces) — `@angular/compiler` must be imported SEQUENTIALLY
   FIRST (JIT facade on `window.ng`), the rest in parallel.
3. **Transpile** — load `typescript` (UMD) from jsdelivr on the host; `ts.transpileModule`
   with `experimentalDecorators` + `emitDecoratorMetadata` + CommonJS.
   BEFORE transpile, rewrite `templateUrl:` → `template: require(...)` and
   `styleUrl(s):` → `styles: [require(...)]` — Angular JIT would otherwise try to *fetch*
   the URL string at runtime. Also rewrite asset `src/href`/`url()` references to blob URLs.
4. **Execute** — compiled CJS module map is postMessage'd into a sandboxed iframe whose
   document is an **srcdoc** (inherits the host CSP AND the host origin, so host-created
   blob: URLs load). The runner is delivered as an external **blob: script** (no
   `unsafe-inline`), and the host CSP grants `'unsafe-eval'` + `blob:` — eval only ever
   runs inside the sandbox. ⚠️ The original `data:` URL doc theory was WRONG (this
   Chromium enforces the parent CSP on `data:` docs too, and a doc-level CSP meta does not
   override it). The runner wraps each module in `new Function('exports','require','module',
   code)` with a synchronous VFS require. Zone.js + reflect-metadata are script-tagged
   into the iframe doc first; Angular JIT bootstraps from `src/main.ts`.

Errors: host-side failures (TS/SCSS/fetch) emit `compileError` and the iframe keeps the
last-good build. Iframe-side failures postMessage structured `runtimeError`.

HMR: every rebuild re-runs `main.ts` in the iframe. If the app stored
`window.__NG_APP_REF__` (demo main.ts does), the runner destroys it and re-bootstraps
(state resets, host page never refreshes); otherwise it falls back to an internal
`location.reload()` of the iframe.

## Conventions & gotchas
- **YAGNI + one-liners**: the PRD is aspirational; prefer the smallest correct thing.
  Cache nothing prematurely; the full module map is retranspiled each build (fast for
  small apps — revisit only if it hurts).
- **CSP**: the demo host page carries a strict CSP (no `unsafe-inline`, no eval in
  host-authored code) but `script-src` must include `'unsafe-eval'` + `blob:` because
  Chromium inherits the host CSP into srcdoc/data: iframes — eval is confined to the
  sandbox, which is the PRD's intent. Do not regress this.
- Keep the runner inside `angular-browser-builder.js` a **self-contained function** — it is
  serialized via `toString()` and executed in the iframe; it must not close over module
  variables or use backticks that break stringification.
- esm.sh URL forms are fragile: subpath packages are `pkg@ver/sub` (scope glued to the
  package), everything must be version-pinned, and `?deps=` aligns hashed rxjs/tslib URLs.
  Empirically verified facts live in `history.md` — read it before changing the pre-fetcher.
- Do not add npm deps or a bundler without a strong reason; the drop-in story is the point.