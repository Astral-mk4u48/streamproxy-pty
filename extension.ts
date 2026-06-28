import * as vscode from 'vscode';
import { StreamProxyTerminalProvider } from './terminalProvider';
import { JsonPanelManager } from './jsonPanelManager';

let panelManager: JsonPanelManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  panelManager = new JsonPanelManager(context);

  // Register the panel manager as a WebviewViewProvider so it lives in the
  // Activity Bar sidebar. The view id must match the one declared under
  // contributes.views in package.json.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'streamproxy-pty.jsonView',
      panelManager,
      {
        // Keep the webview alive when the sidebar tab is hidden so we don't
        // lose scroll position or expanded-entry state on every panel switch.
        webviewOptions: { retainContextWhenHidden: true },
      }
    )
  );

  // Register the custom terminal profile
  const profileProvider = new StreamProxyTerminalProvider(panelManager);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      'streamproxy-pty.profile',
      profileProvider
    )
  );

  // Command: focus / reveal the JSON side panel
  context.subscriptions.push(
    vscode.commands.registerCommand('streamproxy-pty.openPanel', () => {
      panelManager?.reveal();
    })
  );

  // Command: clear all captured payloads from the panel
  context.subscriptions.push(
    vscode.commands.registerCommand('streamproxy-pty.clearPanel', () => {
      panelManager?.clear();
    })
  );
}

export function deactivate() {
  panelManager?.dispose();
}