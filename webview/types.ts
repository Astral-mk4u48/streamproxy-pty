// Shared message contract between the extension host and the webview.
// Keep this in sync with the types in jsonPanelManager.ts — they must match
// exactly because postMessage does no runtime type checking.

export interface JsonEntry {
  id: string;
  timestamp: number;
  payload: unknown;
  terminalId: string;
}

export type ExtToWebview =
  | { type: 'add';      entry: JsonEntry }
  | { type: 'clear' }
  | { type: 'init';     entries: JsonEntry[] }
  | { type: 'scrollTo'; id: string };

export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'clickPlaceholder'; id: string };
