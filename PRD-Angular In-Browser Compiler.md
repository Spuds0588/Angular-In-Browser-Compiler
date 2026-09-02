# Master Development Document: Angular In-Browser Compiler

## Part 1: Product Requirements Document (PRD)

### 1. Product Overview
A front-end only, zero-backend, browser-based compiler and builder for modern Angular (v17+) projects. This library empowers developers to compile, preview, and interact with Angular applications entirely within the browser's memory. It is distributed as a drop-in JavaScript library to maximize ease of use and compatibility.

### 2. Target Audience & Use Cases
*   **Frontend-Only Dev Environments:** Browser-based IDEs, CodePens, or sandbox environments.
*   **Previewing Functions:** Live component previewers for design systems or documentation sites.
*   **Restricted Permission Environments:** Enterprise CRMs or internal portals with strict security policies (CSP) where traditional Node.js/WebContainer build steps are blocked.
*   **LLM & Agentic Workflows (V2):** Autonomous AI coding assistants testing and validating Angular applications using browser skills.

### 3. Core Principles
*   **YAGNI (You Aren't Gonna Need It):** Favor lightweight, synchronous, in-memory solutions over complex AST parsing or AOT Node.js polyfilling.
*   **Drop-in Compatibility:** Users should be able to paste standard Angular CLI code (TypeScript, SCSS, `templateUrl`, NPM imports) without rewriting it for our environment.
*   **Enterprise Security First:** Execution must not rely on main-thread `eval()` to ensure compatibility with strict Content Security Policies (CSP).
*   **Stability over Speed:** Guaranteed compilation correctness (using the official TypeScript compiler API) is prioritized over initial millisecond load times.

### 4. Key Features & Scope

#### V1 Features (Core Product)
*   **Virtual File System (VFS):** In-memory file storage supporting incremental updates and cache invalidation.
*   **Native TypeScript Compilation:** In-browser transpilation utilizing the official Microsoft TS Compiler API.
*   **Dynamic NPM Pre-fetching:** Automatic resolution and downloading of 3rd-party dependencies from ESM CDNs (e.g., `esm.sh`), bypassing the need for a bundler.
*   **Resource Inlining:** Regex-based transpilation to support Angular's `templateUrl` and `styleUrl/styleUrls`.
*   **Lazy-Loaded SCSS:** Bundled (but deferred) Dart Sass WASM engine to support `.scss` files without bloating initial load times.
*   **Sandboxed Iframe Execution:** Apps are mounted inside an auto-generated, secure iframe to bypass `'unsafe-eval'` CSP blockers and isolate CSS/JS.
*   **Compatibility Shims:** 
    *   Auto-injected `MemoryLocationStrategy` (prevents host URL manipulation).
    *   Auto-injected `HttpInterceptor` and Blob URL conversion for local VFS assets (images, JSON).
    *   `process.env` browser shims.
*   **Split HMR (Hot Module Replacement):**
    *   *HTML/CSS edits:* Fast Refresh (seamless UI state preservation).
    *   *TypeScript edits:* Soft Reload (state resets, no page refresh).
*   **Graceful Error Boundaries:** Preserves the "last known good compile" on screen during syntax errors and emits structured, LLM-readable JSON logs to the host.

#### V2 Features (Agentic / LLM)
*   **In-Browser LLM Bridge ("WebMCP"):** A global JS object (`window.__NG_BUILDER_MCP__`) exposing APIs for LLMs using browser-skills to read the VFS, patch files, read structured logs, and inspect the sanitized DOM without manual UI interaction.

---

## Part 2: Implementation Guide (Architecture Blueprint)

### 1. Overall Pipeline Architecture
The engine operates on a single-thread pipeline to compile code before handing it to Angular's Just-In-Time (JIT) compiler.

1.  **Input:** Host app calls `builder.setFiles(filesObject)`.
2.  **Sandbox Validation:** Files are placed in a temporary map.
3.  **Pre-fetcher:** Regex scans `.ts` files for external imports (e.g., `rxjs`, `chart.js`), fetches them asynchronously from `esm.sh`, and caches them globally.
4.  **Transpiler:** 
    *   Converts `templateUrl`/`styleUrl` to synchronous `require()` calls.
    *   Transpiles TypeScript to CommonJS via official TS Compiler API.
    *   Compiles SCSS to CSS via WASM Sass (if applicable).
5.  **VFS Resolution:** Code is wrapped in `new Function('exports', 'require', code)`. The custom `require` maps synchronously to the VFS.
6.  **Mounting:** The compiled output is piped via `postMessage` (or direct document writing) into the Sandboxed Iframe where Angular JIT bootstraps it.

### 2. The Iframe Sandbox (CSP Solution)
To avoid triggering `'unsafe-eval'` on the host domain:
*   The library creates: `<iframe class="ng-builder-frame" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`.
*   The VFS execution context is bound to this iframe's `contentWindow`.
*   User interaction and automated QA (Playwright/Cypress) interact directly with this iframe natively.

### 3. VFS Asset Mapping & HTTP Interception
*   **Binary Assets (Images, Fonts):** When written to the VFS, files are converted to `Blob URLs`. Regex rewrites `<img src="assets/img.png">` to `<img src="blob:https://...">`.
*   **HTTP Requests:** The builder forces a global `HttpInterceptor` into the Angular root providers. `HttpClient.get('assets/data.json')` is intercepted, resolved against the VFS, and returned as a synchronous `HttpResponse`. Misses fall through to the real network.

### 4. V2 LLM Bridge API (`window.__NG_BUILDER_MCP__`)
Exposed globally on the host window:
*   `readVFS(): Object` - Returns `{ 'src/main.ts': '...' }`
*   `patchFiles(filesObject): void` - Updates VFS and triggers HMR pipeline.
*   `getStructuredLogs(): Array<Object>` - Returns JSON logs of the last compilation cycle.
*   `inspectDOM(selector?: string): Object` - Reaches into the iframe and returns a sanitized JSON representation of the DOM state for assertion testing.

---

## Part 3: Developer Task List

### Phase 1: Project Setup & Core API Shell
*   [ ] Initialize project structure (Vanilla JS / ESM modules).
*   [ ] Define the `AngularBrowserBuilder` class and public API (`constructor`, `setFiles`, `updateFile`, `deleteFile`, `run`).
*   [ ] Setup the event emitter interface (`on('compileError')`, `on('success')`).
*   [ ] Implement structured JSON logging utility (`[AngularBuilder::Domain] { ... }`).

### Phase 2: Virtual File System (VFS) & Module Loader
*   [ ] Implement internal VFS Maps (`files`, `compiled`, `modules`).
*   [ ] Build the synchronous `_require(path)` resolver logic (CommonJS wrapper).
*   [ ] Implement relative path resolution (`./`, `../`).
*   [ ] Implement File Deletion logic (purging caches).

### Phase 3: The Transpiler Pipeline
*   [ ] Integrate official TypeScript compiler API (`typescript@5.4+` via CDN).
*   [ ] Configure TS options for Angular JIT (`experimentalDecorators: true`, `emitDecoratorMetadata: true`, `module: CommonJS`).
*   [ ] Write Regex transpiler for `templateUrl` -> `require()`.
*   [ ] Write Regex transpiler for `styleUrl` / `styleUrls` -> `require()`.

### Phase 4: Dependency Management
*   [ ] Implement the Regex NPM Pre-fetcher (scan TS strings for `import ... from 'package'`).
*   [ ] Build async CDN fetch logic targeting `esm.sh` and populate `coreDependencies` cache.

### Phase 5: Execution & Sandbox Mounting
*   [ ] Implement dynamic Iframe generation with strict `sandbox` attributes.
*   [ ] Build mechanism to inject Angular dependencies (`zone.js`, `reflect-metadata`) into the iframe document.
*   [ ] Pipe VFS execution into the iframe context.
*   [ ] Handle App teardown / `ApplicationRef.destroy()` logic on reload.

### Phase 6: Angular Compatibility Layer
*   [ ] Build DI injector for `MemoryLocationStrategy` (Routing).
*   [ ] Build `HttpInterceptor` class for `HttpClient` VFS asset resolution.
*   [ ] Build VFS Blob URL generator and HTML Regex replacer for static `<img>` and font assets.
*   [ ] Inject `window.process = { env: { NODE_ENV: 'development' } }` into iframe window.

### Phase 7: SCSS Integration
*   [ ] Integrate Dart Sass WASM (lazy-loaded on first `.scss` detection).
*   [ ] Write custom Sass importer function to map `@import` statements to VFS paths.
*   [ ] Pipe compiled CSS into the standard module resolution cache.

### Phase 8: State Management & Error Boundaries
*   [ ] Implement "Sandbox Map" logic (fork VFS on update, test compile, merge on success).
*   [ ] Implement HTML/CSS Fast Refresh (Clear Angular template cache + `appRef.tick()`).
*   [ ] Implement TS Soft Reload (Destroy AppRef + Re-bootstrap without page reload).
*   [ ] Connect crash handler to emit structured error payload to host instead of crashing UI.

### Phase 9: LLM Bridge (V2)
*   [ ] Expose `window.__NG_BUILDER_MCP__` object.
*   [ ] Implement `readVFS()` and `patchFiles()`.
*   [ ] Implement `getStructuredLogs()` linking to Phase 1 logging utility.
*   [ ] Implement `inspectDOM()` crossing the iframe boundary safely to return JSON DOM representation.