import * as vscode from 'vscode';
import { StreamProxyPseudoterminal } from './pseudoterminal';
import { JsonPanelManager } from './jsonPanelManager';

export class StreamProxyTerminalProvider implements vscode.TerminalProfileProvider {
  constructor(private readonly panelManager: JsonPanelManager) {}

  provideTerminalProfile(
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.TerminalProfile> {
    const pty = new StreamProxyPseudoterminal(this.panelManager);
    return new vscode.TerminalProfile({
      name: 'StreamProxy Shell',
      pty,
    });
  }
}
