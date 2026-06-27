import * as vscode from 'vscode';

export interface JsonEntry {
  id: string;
  timestamp: number;
  payload: unknown;
  // Which terminal tab sent this.
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

export class JsonPanelManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private entries: JsonEntry[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly maxEntries: number;

  // If scrollToEntry() fires before the panel exists we can't send anything yet —
  // the webview isn't alive. Stash the id here and deliver it once 'ready' comes in.
  private pendingScrollId: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.maxEntries = vscode.workspace
      .getConfiguration('streamproxy-pty')
      .get<number>('maxPanelEntries', 500);
  }

  addPayload(entry: JsonEntry): void {
    this.entries.push(entry);
    // Drop the oldest once we hit the cap.
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    if (this.panel) {
      this.post({ type: 'add', entry });
    } else {
      // First payload — pop the panel open automatically.
      this.reveal();
    }
  }

  // Called when the user clicks a placeholder link in the terminal.
  scrollToEntry(id: string): void {
    if (this.panel) {
      // Panel is already open, just send it straight through.
      this.reveal();
      this.post({ type: 'scrollTo', id });
    } else {
      // Panel doesn't exist yet — stash the id and reveal() will create it.
      // We'll send the scroll once the webview posts back 'ready'.
      this.pendingScrollId = id;
      this.reveal();
    }
  }

  reveal(): void {
    if (this.panel) {
      // Panel is already alive — just focus it.
      //
      // No need to re-send 'init' here. retainContextWhenHidden keeps the
      // webview in memory when it's hidden, so its state is still current.
      // Re-blasting the whole entries buffer on every reveal() call would
      // just be wasted IPC — especially if a second terminal opening triggers
      // this dozens of times. The 'init' only needs to go out once, when a
      // fresh webview first boots up, and that's handled in createPanel() via
      // the 'ready' handshake.
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.createPanel();
  }

  clear(): void {
    this.entries = [];
    this.post({ type: 'clear' });
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private createPanel(): void {
    this.panel = vscode.window.createWebviewPanel(
      'streamproxy-json-panel',
      'StreamProxy JSON',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'dist'),
        ],
      }
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExt) => {
        if (msg.type === 'ready') {
          // Webview just booted — send everything it missed while it was closed.
          this.post({ type: 'init', entries: this.entries });

          // If scrollToEntry() was called before the panel existed, deliver
          // the scroll now that the webview is actually up and ready.
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

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, undefined, this.disposables);
  }

  // Wrap in a try/catch because postMessage will violently crash the extension
  // host if the payload has circular references or non-cloneable values like
  // Symbols or Functions that slipped through JSON.parse. First we retry with
  // a JSON-sanitised copy to strip the bad stuff; if that also fails we log
  // and drop rather than take down the whole session.
  private post(msg: ExtToWebview): void {
    if (!this.panel) { return; }
    try {
      this.panel.webview.postMessage(msg);
    } catch (err) {
      try {
        // JSON round-trip nukes anything the structured clone algorithm chokes on.
        const sanitised: ExtToWebview = JSON.parse(JSON.stringify(msg));
        this.panel.webview.postMessage(sanitised);
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

  private buildHtml(): string {
    const webview = this.panel!.webview;
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
  <div id="root"></div>
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