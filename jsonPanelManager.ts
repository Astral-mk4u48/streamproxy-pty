import * as vscode from 'vscode';

export interface JsonEntry {
  id: string;
  timestamp: number;
  payload: unknown;
  terminalId: string;
}

// Extension → webview
type ExtToWebview =
  | { type: 'add';      entry: JsonEntry }
  | { type: 'clear' }
  | { type: 'init';     entries: JsonEntry[] }
  | { type: 'scrollTo'; id: string };

// Webview → extension
type WebviewToExt =
  | { type: 'ready' }
  | { type: 'clickPlaceholder'; id: string };

// The view id must match the one declared in package.json under
// contributes.views.streamproxy-container.
const VIEW_ID = 'streamproxy-pty.jsonView';

// JsonPanelManager now implements WebviewViewProvider so the panel lives in
// the Activity Bar sidebar rather than as a floating editor-area panel.
// VS Code calls resolveWebviewView() the first time the user opens the view
// (or on reload), hands us the WebviewView, and we own it from there.
//
// The public API (addPayload / scrollToEntry / reveal / clear / dispose)
// is intentionally unchanged — pseudoterminal.ts and extension.ts don't
// need to know anything about the move to the sidebar.
export class JsonPanelManager
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private entries: JsonEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly maxEntries: number;

  // Scroll request that arrived before the view was resolved — deliver it
  // in resolveWebviewView() once the webview is actually alive.
  private pendingScrollId: string | undefined;

  // True only after the webview has posted 'ready'. There's a window between
  // resolveWebviewView() setting this.view and the webview JS actually running
  // where postMessage calls would be silently dropped. We hold off sending
  // 'add' messages until ready fires — at which point 'init' catches up
  // everything that queued up in this.entries anyway.
  private webviewReady = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.maxEntries = vscode.workspace
      .getConfiguration('streamproxy-pty')
      .get<number>('maxPanelEntries', 500);
  }

  // ── WebviewViewProvider ───────────────────────────────────────────────────

  // VS Code calls this once when the view is first shown. We set up the
  // webview options, inject the HTML, and wire up message listeners here.
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist'),
      ],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExt) => {
        if (msg.type === 'ready') {
          // Webview just booted (or reloaded) — send the full buffer.
          // Mark ready first so any post() calls inside init dispatch correctly.
          this.webviewReady = true;
          this.post({ type: 'init', entries: this.entries });

          if (this.pendingScrollId !== undefined) {
            this.post({ type: 'scrollTo', id: this.pendingScrollId });
            this.pendingScrollId = undefined;
          }
        } else if (msg.type === 'clickPlaceholder') {
          this.scrollToEntry(msg.id);
        }
      },
      undefined,
      this.disposables
    );

    // Clean up our reference when the view is disposed (e.g. panel dragged
    // away or VS Code closed). resolveWebviewView() will be called again if
    // the user reopens the view.
    webviewView.onDidDispose(() => {
      this.view = undefined;
      // Webview context is gone — reset so the next resolveWebviewView()
      // waits for a fresh 'ready' before sending messages.
      this.webviewReady = false;
    }, undefined, this.disposables);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  addPayload(entry: JsonEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    if (this.webviewReady) {
      // Webview is fully booted — stream the entry straight in.
      this.post({ type: 'add', entry });
    } else {
      // Either the view doesn't exist yet or it exists but the JS hasn't
      // posted 'ready' — both cases are fine. The entry is already in
      // this.entries, so the next 'init' will include it automatically.
      // Just make sure the panel is visible so the user can see it arrive.
      this.reveal();
    }
  }

  scrollToEntry(id: string): void {
    if (this.view) {
      this.reveal();
      this.post({ type: 'scrollTo', id });
    } else {
      this.pendingScrollId = id;
      this.reveal();
    }
  }

  // Focuses the sidebar view. The second arg (preserveFocus) keeps the
  // editor/terminal focused so calling this on every payload doesn't keep
  // stealing keyboard focus away from the terminal.
  reveal(): void {
    vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  clear(): void {
    this.entries = [];
    this.post({ type: 'clear' });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  // Same safe-post logic as before — JSON round-trip as fallback to avoid
  // crashing the extension host on uncloneable values.
  private post(msg: ExtToWebview): void {
    if (!this.view) { return; }
    try {
      this.view.webview.postMessage(msg);
    } catch (err) {
      try {
        const sanitised: ExtToWebview = JSON.parse(JSON.stringify(msg));
        this.view.webview.postMessage(sanitised);
      } catch (innerErr) {
        console.error(
          '[StreamProxy] Failed to send message to webview.',
          'Original error:', err,
          'Sanitise error:', innerErr,
          'Message type:', msg.type
        );
      }
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      'webview',
      'dist'
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, 'webview.css')
    );
    const nonce = getNonce();

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="
      default-src 'none';
      style-src  ${webview.cspSource} 'unsafe-inline';
      script-src ${webview.cspSource} 'nonce-${nonce}';
      font-src   ${webview.cspSource};
    "
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>StreamProxy JSON</title>
</head>
<body>
  <div class="toolbar">
    <input
      id="search"
      class="search"
      type="text"
      placeholder="Filter payloads…"
      autocomplete="off"
      spellcheck="false"
    />
    <span id="count" class="count-badge"></span>
    <button id="clear-btn" class="btn" title="Clear all payloads">⌫</button>
  </div>

  <div class="scroll-container">
    <div id="empty" class="empty-state" style="display:none">
      <span class="empty-icon">⬡</span>
      <span>No JSON payloads yet.</span>
      <span>Run something in a StreamProxy Shell terminal.</span>
    </div>
    <div id="list"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(
    { length: 32 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}