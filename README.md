# Angular-In-Browser-Compiler

A front-end-only, zero-backend, browser-based compiler and builder for modern Angular
(v17+) projects. Drop-in ESM library — no bundler, no Node, no build step.

## What it does

Feed it a virtual file system (TypeScript + HTML + CSS/SCSS + JSON + assets) and it:

1. **Transpiles** TypeScript in the browser (official `ts.transpileModule`, JIT decorators on).
2. **Pre-fetches** npm deps from esm.sh — `@angular/*`, `rxjs`, `tslib` in default mode
   (all cross-package imports rewritten to absolute URLs, `?deps=` pins one shared copy),
   user deps as self-contained `?bundle` modules.
3. **Executes** the app inside a sandboxed `srcdoc` iframe that inherits the host CSP:
   Angular JIT bootstrap, `new Function` CJS wrapper — all eval confined to the sandbox.
4. **Hot-reloads**: a stylesheet-only edit is a **fast refresh** — the app is not torn down, so
   component state and the active route survive; TypeScript/HTML edits soft-reload
   (re-transpile + re-bootstrap, state resets).
5. **Guards errors**: TS `diagnostics` are checked before anything reaches the sandbox
   (`compileError`, last-good build kept); runtime errors stream back as `runtimeError`.

## CSP contract (read before using)

The host page must allow the iframe to evaluate, but *your own code* never evals:

```
script-src 'self' https://cdn.jsdelivr.net https://esm.sh blob: 'unsafe-eval';
```

- `'unsafe-eval'` is granted globally but **only the sandbox ever evaluates** (CJS wrapper
  + Angular JIT need it). Chromium inherits the host CSP into `srcdoc`/`data:` iframes.
- `blob:` allows the runner script (external, so no `unsafe-inline` is needed).
- `https://cdn.jsdelivr.net` + `https://esm.sh` for TS, zone.js, reflect-metadata, deps.
- No `unsafe-inline` anywhere — the runner is a blob: script, styles are injected as
  text via CSSOM-safe means.

## Quick start

```js
import { AngularBrowserBuilder } from 'angular-browser-builder';

const builder = new AngularBrowserBuilder({ container: document.getElementById('app') });

builder.on('success', () => console.log('app running'));
builder.on('compileError', (e) => console.error('compile error:', e.data.message));
builder.on('runtimeError', (e) => console.error('runtime error:', e));

builder.setFiles({
  'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
bootstrapApplication(AppComponent);`,
  'src/app/app.component.ts': `import { Component } from '@angular/core';
@Component({ selector: 'app-root', standalone: true, template: '<h1>Hello</h1>' })
export class AppComponent {}`,
});
```

See `demo/` for a full interactive host page (editor + Apply/Recolor/Break/Fix buttons,
structured log panel).

## API

| Method | Purpose |
| --- | --- |
| `setFiles(files)` / `updateFile(path, content)` / `batch(files)` / `deleteFile(path)` / `getFile(path)` | VFS mutations (each triggers a rebuild; `batch` applies several files with ONE build) |
| `on('success' \| 'compileError' \| 'runtimeError' \| 'log', fn)` | Events; `log` entries are `{ ts, level, domain, message, data }` |
| `new AngularBrowserBuilder({ container, versions, main })` | `versions` overrides pin (defaults: Angular 17.3.12, rxjs 7.8.1, TS 5.4.5, sass 1.86.3) |

## Feature support (V1)

- Standalone components, `templateUrl`/`styleUrl(s)` (rewritten to inlined `require()` —
  Angular JIT would otherwise **fetch** the URL string), AsyncPipe, DI, HttpClient.
- **Router**: auto-injected `MemoryLocationStrategy` + `APP_BASE_HREF: '/'` keep
  navigation entirely in the sandbox — the host URL/history is never touched.
  `provideRouter` apps just work; back/forward via `Location.back()`/`forward()`
  (or links) drive the Router through the memory strategy's popstate listeners.
  Browser back-button won't navigate (by design — it would manipulate the host history).
- **Auto-injected VFS HttpInterceptor** — `HttpClient.get('assets/data.json')` resolves
  from the VFS (via `withInterceptorsFromDi()` + `HTTP_INTERCEPTORS`); misses fall
  through to the network. No manual wiring needed.
- **Assets**: text/data-URL assets become blob URLs; `assets/...` refs in templates and
  CSS are rewritten at compile time (lookup handles `assets/…` vs `src/assets/…`).
- SCSS (lazy Dart Sass via esm.sh, `compileStringAsync`) with a custom importer:
  `@import`/`@use` of other VFS `.scss` files (partials like `_variables.scss`,
  `_index.scss` dirs, `./` `../` and root-relative paths) just work, **and** bare npm
  packages resolve through their `exports` map (`sass` condition) to files fetched
  from jsdelivr — e.g. `@use '@angular/material' as mat;` then
  `mat.get-color-from-palette(mat.$indigo-palette, 500)` works, including the
  transitive MDC `@material/*` packages (versions come from the consuming package's
  dependencies; pinned package versions live in the builder's `versions` map). The
  demo shares a `src/app/_variables.scss` whose `$brand` is Material-derived.
- **Fast refresh (styles)**: an SCSS/CSS-only rebuild recompiles the stylesheets and patches
  the live `<style>` nodes inside the sandbox (no re-bootstrap) — counters, form state and
  the current route survive the edit. When a sheet cannot be matched to a live node the
  builder falls back to a soft reload. Template edits still soft-reload: Angular 17 has no
  public API to swap a live component's template.
- Error boundaries: compile errors keep the last-good build on screen.

## Known limits (see to-do.md)

- No TEMPLATE fast refresh (HTML edits soft-reload — Angular 17 lacks the HMR metadata API),
  global `styles.css` from angular.json unsupported, binaries must be `data:` URLs, sass
  installs a small `globalThis.require` stub on the host, a bare `@use "x"` prefers the
  importing file's dir over the VFS root.

## License

MIT