import * as vscode from 'vscode';
import * as os from 'os';
import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { StreamParser } from './streamParser';
import { JsonPanelManager } from './jsonPanelManager';

// ANSI escape sequences used for the intercepted-JSON placeholder
const ANSI_RESET   = '\x1b[0m';
const ANSI_BOLD    = '\x1b[1m';
const ANSI_DIM     = '\x1b[2m';
const ANSI_CYAN    = '\x1b[36m';
const ANSI_MAGENTA = '\x1b[35m';

function makePlaceholder(id: string, previewKey: string): string {
  return (
    `\r\n${ANSI_BOLD}${ANSI_CYAN}` +
    `⬡ [JSON Payload Intercepted — id:${id}]` +
    `${ANSI_RESET} ${ANSI_DIM}${previewKey}${ANSI_RESET}` +
    ` ${ANSI_MAGENTA}→ View in Side Panel${ANSI_RESET}\r\n`
  );
}

export class StreamProxyPseudoterminal implements vscode.Pseudoterminal {
  // VS Code reads from these emitters to update the terminal UI
  private readonly _onDidWrite   = new vscode.EventEmitter<string>();
  private readonly _onDidClose   = new vscode.EventEmitter<number>();
  private readonly _onDidOverrideDimensions =
    new vscode.EventEmitter<vscode.TerminalDimensions | undefined>();

  readonly onDidWrite             = this._onDidWrite.event;
  readonly onDidClose             = this._onDidClose.event;
  readonly onDidOverrideDimensions = this._onDidOverrideDimensions.event;

  /**
   * FIX (definite-assignment assertions): shell and parser are assigned in
   * open(), which VS Code calls after construction. Using `!` asserted types
   * masks the real possibility of close() or handleInput() being called
   * before open() (e.g. rapid tab creation/destruction). Typing them as
   * `| undefined` and using optional chaining at every call site is the
   * correct representation of their actual lifecycle, and lets TypeScript
   * catch any future accidental dereferences.
   */
  private shell: pty.IPty | undefined;
  private parser: StreamParser | undefined;
  private cols = 80;
  private rows = 24;

  // Flipped to true whenever a control character arrives mid-paste or the tab
  // closes. The setImmediate drain loop checks this on every tick and bails
  // out immediately rather than continuing to feed a dead or interrupted shell.
  private pasteAborted = false;

  // Timestamp (ms) until which shell.onData output should bypass the parser
  // and go straight to onText. Set on every handleInput write; expires after
  // ECHO_WINDOW_MS. This is how we stop echoed keystrokes from being mistaken
  // for JSON — a `{` the user typed echoes back through onData and would
  // otherwise open a capture that freezes the terminal until a matching `}`.
  private echoWindowUntil = 0;
  private static readonly ECHO_WINDOW_MS = 50;

  /**
   * Stable per-instance identifier.
   *
   * Without this, when a second StreamProxy terminal opens while the JSON
   * panel is already visible, `addPayload()` calls `reveal()` which re-sends
   * `init` with ALL buffered entries — but there's no way for the webview (or
   * the extension host) to know which entries came from which terminal tab.
   *
   * By tagging every JsonEntry with `terminalId`, the webview can:
   *  • Group / filter entries by terminal
   *  • Correctly deduplicate on re-sync (upsert by `entry.id`)
   *  • Show a "Terminal 1 / Terminal 2" label in the UI
   */
  private readonly terminalId: string = randomBytes(4).toString('hex');

  constructor(private readonly panelManager: JsonPanelManager) {}

  // Called by VS Code when the terminal tab is opened
  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.cols = initialDimensions.columns;
      this.rows = initialDimensions.rows;
    }

    const shellPath = this.resolveShell();

    // Spawn the real shell via node-pty so we get a proper PTY fd
    this.shell = pty.spawn(shellPath.exe, shellPath.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      // Prefer the open workspace folder so `node test-stream.js` just works.
      // Falling back through USERPROFILE covers Windows (HOME is often unset
      // there), then os.homedir() as a cross-platform last resort. We
      // deliberately avoid process.cwd() — inside the extension host that
      // resolves to the VS Code install directory, not the user's project.
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ?? process.env.HOME
        ?? process.env.USERPROFILE
        ?? os.homedir(),
      env: process.env as { [key: string]: string },
    });

    // Set up the stream parser (runs synchronously in this demo; see streamParser.ts
    // for the WebWorker variant notes)
    this.parser = new StreamParser({
      onText: (chunk) => {
        this._onDidWrite.fire(chunk);
      },
      onJson: (id, payload) => {
        // Send a lightweight placeholder to the terminal UI
        const preview = this.buildPreview(payload);
        this._onDidWrite.fire(makePlaceholder(id, preview));

        // Send the real payload to the webview panel via IPC, tagged with
        // this terminal instance's stable id so the webview can group/filter.
        this.panelManager.addPayload({
          id,
          timestamp: Date.now(),
          payload,
          terminalId: this.terminalId,
        });
      },
    });

    // Pipe shell stdout → parser (or passthrough if we're in the echo window).
    // Every handleInput write bumps echoWindowUntil forward by ECHO_WINDOW_MS.
    // Bytes that arrive while the clock is still running are echoed keystrokes —
    // hand them straight to onText via passthrough() so the bracket counter
    // never sees them. Bytes that arrive after the window expires are real
    // program output and go through the full parser as normal.
    this.shell.onData((data: string) => {
      if (Date.now() < this.echoWindowUntil) {
        this.parser?.passthrough(data);
      } else {
        this.parser?.push(data);
      }
    });

    // Shell exited — close the terminal tab
    this.shell.onExit(({ exitCode }) => {
      this._onDidClose.fire(exitCode ?? 0);
    });
  }

  // VS Code calls this for every keystroke the user types in the terminal UI.
  // Single keystrokes arrive as a 1-char string and go straight through.
  // Paste lands here too — as one big string all at once. node-pty's write
  // buffer on Windows silently drops anything over ~1 KB delivered in a single
  // call, so we slice large inputs into 512-byte chunks and drain them one
  // setImmediate tick apart. That matches the pace node-pty can actually
  // consume without losing data, while keeping latency invisible for normal typing.
  handleInput(data: string): void {
    if (!this.shell) { return; }

    // Control characters (Ctrl+C → \x03, Ctrl+D → \x04, Ctrl+Z → \x1a, etc.)
    // must always jump straight to the shell, even if a paste drain is already
    // in flight. Letting them queue behind 50+ pending chunks means the user
    // has to wait for the entire paste to finish before the signal lands —
    // which is exactly what made Ctrl+C feel broken. We detect them by checking
    // for any byte below 0x20 (the ASCII control range).
    const isControl = data.length === 1 && data.charCodeAt(0) < 0x20;
    if (isControl) {
      // Cancel any in-flight paste drain so the control character takes effect
      // immediately. The next paste will start fresh with a clean flag.
      this.pasteAborted = true;
      // No echo window for control characters — Ctrl+C doesn't echo visible
      // bytes so there's nothing for the parser to misread.
      this.shell.write(data);
      return;
    }

    const CHUNK = 512;
    if (data.length <= CHUNK) {
      // Fast path — normal keystrokes never hit the chunk limit.
      // Bump the echo window so the shell's echo of these bytes goes through
      // passthrough() rather than the JSON parser.
      this.pasteAborted = false;
      this.echoWindowUntil = Date.now() + StreamProxyPseudoterminal.ECHO_WINDOW_MS;
      this.shell.write(data);
      return;
    }

    // Slow path — paste. Reset the abort flag for this new run, write the
    // first chunk immediately so there's no perceptible delay, then schedule
    // the rest one tick at a time so node-pty's buffer can drain between writes.
    // The echo window is extended per-chunk inside writeNext so it stays open
    // for the full duration of the paste, not just the first 50ms.
    this.pasteAborted = false;
    let offset = 0;
    const writeNext = (): void => {
      // Bail if the tab was closed or the user hit Ctrl+C mid-paste.
      if (!this.shell || this.pasteAborted || offset >= data.length) { return; }
      // Keep the echo window open for the duration of the paste — each chunk
      // resets the clock so the parser stays in passthrough the whole time.
      this.echoWindowUntil = Date.now() + StreamProxyPseudoterminal.ECHO_WINDOW_MS;
      this.shell.write(data.slice(offset, offset + CHUNK));
      offset += CHUNK;
      if (offset < data.length) {
        setImmediate(writeNext);
      }
    };
    writeNext();
  }

  // VS Code calls this when the terminal panel is resized
  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.cols = dimensions.columns;
    this.rows = dimensions.rows;
    this.shell?.resize(this.cols, this.rows);
    this._onDidOverrideDimensions.fire(dimensions);
  }

  // VS Code calls this when the tab is closed
  close(): void {
    // Kill any in-flight paste drain before taking down the shell — otherwise
    // the writeNext loop keeps firing setImmediate callbacks into a dead pty.
    this.pasteAborted = true;
    try { this.shell?.kill(); } catch { /* already dead */ }
    this.parser?.destroy();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resolveShell(): { exe: string; args: string[] } {
    if (os.platform() !== 'win32') {
      // SHELL is always a real path on Unix/macOS — no need to poke VS Code config.
      return { exe: process.env.SHELL ?? '/bin/bash', args: [] };
    }

    // Windows: prefer something modern over cmd.exe.
    //
    // Priority:
    //  1. PowerShell 7+ (pwsh.exe) — ships with Win10/11, good ANSI support
    //  2. Git Bash (bash.exe inside a standard Git for Windows install)
    //  3. Windows PowerShell 5 (powershell.exe) — always present on Win10+
    //  4. cmd.exe — last resort, but at least it works
    //
    // We spawn with -NoLogo / --login so the prompt comes up clean without
    // the copyright banner eating the first line.
    const fs = require('fs') as typeof import('fs');

    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    if (fs.existsSync(pwsh)) {
      return { exe: pwsh, args: ['-NoLogo'] };
    }

    // Git for Windows drops bash.exe here by default. Check the two most
    // common install paths — per-machine and per-user.
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\bin\\bash.exe`,
    ];
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) {
        // --login gives us the full Unix PATH from .bash_profile/.profile
        return { exe: p, args: ['--login', '-i'] };
      }
    }

    // Windows PowerShell 5 — always present on Win10+, no external install needed.
    return {
      exe: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ['-NoLogo'],
    };
  }

  private buildPreview(payload: unknown): string {
    if (payload === null || payload === undefined) { return '(null)'; }
    if (typeof payload !== 'object') { return String(payload).slice(0, 40); }
    const keys = Object.keys(payload as object);
    if (keys.length === 0) { return '{}'; }
    const first = keys[0];
    const val = (payload as Record<string, unknown>)[first];
    const valStr =
      typeof val === 'object' ? '{…}' : String(val).slice(0, 24);
    return `{${first}: ${valStr}${keys.length > 1 ? ', …' : ''}}`;
  }
}