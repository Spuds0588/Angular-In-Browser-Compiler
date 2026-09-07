/** The sample Angular app, packaged as the VFS file map handed to the builder. */
export const appFiles = {
  'src/main.ts': `
import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent)
  .then((ref) => { window.__NG_APP_REF__ = ref; })
  .catch((err) => console.error(err));
`,

  'src/app/app.component.ts': `
import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DataService } from './data.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent {
  title = 'ng-builder-demo';
  count = 0;
  constructor(public data: DataService) {}
  inc() { this.count++; }
}
`,

  'src/app/app.component.html': `
<h1>{{ title }}</h1>
<p>Count: <strong>{{ count }}</strong> <button (click)="inc()">+1</button></p>
<p>Data: <em>{{ (data.message$ | async)?.message }}</em></p>
<img src="assets/logo.png" alt="logo" width="48">
<p class="hint">Edit the files on the left and hit Apply.</p>
`,

  'src/app/app.component.css': `
h1 { color: #c0392b; font-family: sans-serif; }
.hint { color: #888; font-size: 12px; }
button { padding: 2px 10px; cursor: pointer; }
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