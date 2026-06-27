import * as vscode from 'vscode';
import { StreamProxyTerminalProvider } from './terminalProvider';
import { JsonPanelManager } from './jsonPanelManager';

let panelManager: JsonPanelManager | undefined;

export function activate(context: vscode.ExtensionContext) {
  panelManager = new JsonPanelManager(context);

  // Register the custom terminal profile
  const profileProvider = new StreamProxyTerminalProvider(panelManager);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      'streamproxy-pty.profile',
      profileProvider
    )
  );

  // Command: open / reveal the JSON side panel
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
