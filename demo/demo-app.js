/** The sample Angular app, packaged as the VFS file map handed to the builder. */
export const appFiles = {
  'src/main.ts': `
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { AppComponent, routes } from './app/app.component';

bootstrapApplication(AppComponent, { providers: [provideRouter(routes)] })
  .then((ref) => { window.__NG_APP_REF__ = ref; })
  .catch((err) => console.error(err));
`,

  'src/app/app.component.ts': `
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HomeComponent } from './home.component';
import { AboutComponent } from './about.component';

export const routes = [
  { path: '', component: HomeComponent },
  { path: 'about', component: AboutComponent },
];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent { title = 'ng-builder-demo'; }
`,

  'src/app/app.component.html': `
<h1>{{ title }}</h1>
<nav>
  <a routerLink="/" routerLinkActive="active">Home</a>
  <a routerLink="/about" routerLinkActive="active">About</a>
</nav>
<router-outlet></router-outlet>
`,

  'src/app/_variables.scss': `
// Shared design tokens — @use'd by app.component.scss and home.component.scss.
$brand: #7c3aed;
$accent: #c0392b;
$nav-bg: #f1f5f9;
$border: #e2e8f0;
$text: #334155;
$muted: #888;
`,

  'src/app/app.component.scss': `
@use './variables';
nav { background: variables.$nav-bg; padding: 8px 12px; border-bottom: 1px solid variables.$border; display: flex; gap: 12px; }
nav a { color: variables.$text; text-decoration: none; font-weight: 600; }
nav a.active { color: variables.$brand; border-bottom: 2px solid variables.$brand; }
h1 { color: variables.$brand; font-family: sans-serif; }
`,

  'src/app/home.component.ts': `
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataService } from './data.service';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
})
export class HomeComponent {
  count = 0;
  constructor(public data: DataService) {}
  inc() { this.count++; }
}
`,

  'src/app/home.component.html': `
<p>Count: <strong>{{ count }}</strong> <button (click)="inc()">+1</button></p>
<p>Data: <em>{{ (data.message$ | async)?.message }}</em></p>
<img src="assets/logo.png" alt="logo" width="48">
<p class="hint">Edit the files on the left and hit Apply.</p>
`,

  'src/app/home.component.scss': `
@use './variables';
button { padding: 2px 10px; cursor: pointer; }
.hint { color: variables.$muted; font-size: 12px; }
`,

  'src/app/about.component.ts': `
import { Component } from '@angular/core';

@Component({
  selector: 'app-about',
  standalone: true,
  template: '<h2>About</h2><p>This page is served by the Router inside the sandbox — the host URL never changes (MemoryLocationStrategy).</p>',
})
export class AboutComponent {}
`,

  'src/app/data.service.ts': `
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class DataService {
  message$: Observable<any>;
  constructor(http: HttpClient) {
    // Resolved by the auto-injected VFS HttpInterceptor — no network involved.
    this.message$ = http.get('assets/data.json');
  }
}
`,

  'src/assets/data.json': `{ "message": "Hello from VFS JSON via HttpInterceptor!" }`,

  // 1x1 red PNG as a data URL (V1 binary assets must be supplied this way).
  'src/assets/logo.png':
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
};