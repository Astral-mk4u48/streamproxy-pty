// StreamProxy webview frontend.
//
// Owns the full UI lifecycle: receives messages from the extension host,
// maintains a local entries array, handles search/filter, renders entry
// cards with collapsible JSON trees, and posts 'ready' back on boot so
// the extension knows it can start sending data.
//
// No framework, no runtime dependencies — just TypeScript compiled to an
// IIFE by esbuild. Keeps the bundle tiny and avoids version-churn headaches
// inside the extension's webview sandbox.

import { JsonEntry, ExtToWebview, WebviewToExt } from './types';
import { renderJsonTree } from './jsonTree';

// ── VS Code API ────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── State ──────────────────────────────────────────────────────────────────

// All entries received from the extension, newest at the end.
let allEntries: JsonEntry[] = [];

// Subset currently shown after applying the search filter.
let visibleEntries: JsonEntry[] = [];

// Which entry is currently expanded (only one at a time).
let expandedId: string | null = null;

// The entry the extension asked us to scroll to / highlight.
let highlightedId: string | null = null;

// Map terminalId → stable colour slot so each terminal gets a consistent dot.
const termColourMap = new Map<string, number>();
let nextColourSlot = 0;
const COLOUR_COUNT = 6; // matches --sp-term-0 … --sp-term-5 in CSS

function termColour(terminalId: string): string {
  if (!termColourMap.has(terminalId)) {
    termColourMap.set(terminalId, nextColourSlot % COLOUR_COUNT);
    nextColourSlot++;
  }
  return `var(--sp-term-${termColourMap.get(terminalId)})`;
}

// ── DOM refs ───────────────────────────────────────────────────────────────

const searchEl    = document.getElementById('search')    as HTMLInputElement;
const clearBtn    = document.getElementById('clear-btn') as HTMLButtonElement;
const countEl     = document.getElementById('count')     as HTMLElement;
const listEl      = document.getElementById('list')      as HTMLElement;
const emptyEl     = document.getElementById('empty')     as HTMLElement;

// ── Rendering ──────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// Build a one-line preview string for the collapsed header.
function buildPreview(payload: unknown): string {
  if (payload === null)              { return 'null'; }
  if (typeof payload !== 'object')   { return String(payload).slice(0, 80); }
  if (Array.isArray(payload)) {
    return `[ ${(payload as unknown[]).length} items ]`;
  }
  const keys = Object.keys(payload as object);
  if (keys.length === 0)             { return '{ }'; }
  const first = keys[0];
  const val   = (payload as Record<string, unknown>)[first];
  const valStr = typeof val === 'object'
    ? (Array.isArray(val) ? '[…]' : '{…}')
    : JSON.stringify(val)?.slice(0, 30) ?? 'null';
  return `{ "${first}": ${valStr}${keys.length > 1 ? ', … }' : ' }'}`;
}

function createEntryEl(entry: JsonEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'entry';
  el.dataset.id = entry.id;

  if (entry.id === expandedId)   { el.classList.add('expanded'); }
  if (entry.id === highlightedId){ el.classList.add('highlighted'); }

  // ── Header row ────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'entry-header';

  const arrow = document.createElement('span');
  arrow.className = 'entry-arrow';
  arrow.textContent = '▶';

  const dot = document.createElement('span');
  dot.className = 'term-dot';
  dot.style.background = termColour(entry.terminalId);
  dot.title = `Terminal ${entry.terminalId}`;

  const preview = document.createElement('span');
  preview.className = 'entry-preview';
  preview.textContent = buildPreview(entry.payload);

  const meta = document.createElement('div');
  meta.className = 'entry-meta';

  const time = document.createElement('span');
  time.className = 'entry-time';
  time.textContent = formatTime(entry.timestamp);

  const idBadge = document.createElement('span');
  idBadge.className = 'entry-id';
  idBadge.textContent = entry.id;

  meta.appendChild(time);
  meta.appendChild(idBadge);

  header.appendChild(arrow);
  header.appendChild(dot);
  header.appendChild(preview);
  header.appendChild(meta);

  // ── Body (JSON tree, hidden until expanded) ────────────────────────────
  const body = document.createElement('div');
  body.className = 'entry-body';

  // Lazy-render the tree — don't build DOM for every entry upfront.
  // The tree gets created the first time the entry is expanded.
  let treeBuilt = false;

  header.addEventListener('click', () => {
    const isNowExpanded = !el.classList.contains('expanded');

    // Collapse the previously expanded entry.
    if (expandedId && expandedId !== entry.id) {
      const prev = listEl.querySelector(`[data-id="${expandedId}"]`);
      prev?.classList.remove('expanded');
    }

    el.classList.toggle('expanded', isNowExpanded);
    expandedId = isNowExpanded ? entry.id : null;

    // Build the tree lazily on first expand.
    if (isNowExpanded && !treeBuilt) {
      body.appendChild(renderJsonTree(entry.payload));
      treeBuilt = true;
    }
  });

  el.appendChild(header);
  el.appendChild(body);
  return el;
}

// Full re-render of the list — called after init, clear, or filter change.
// For streaming updates (add), appendEntry() is used instead so we don't
// re-create every DOM node on every incoming payload.
function renderList(): void {
  listEl.innerHTML = '';

  const isEmpty = visibleEntries.length === 0;
  // Always set both — the HTML has display:none on #empty as a starting
  // point but we take full ownership of visibility from here on.
  emptyEl.style.display = isEmpty ? 'flex' : 'none';
  listEl.style.display  = isEmpty ? 'none'  : 'block';

  updateCount();

  for (const entry of visibleEntries) {
    listEl.appendChild(createEntryEl(entry));
  }
}

// Append a single new entry without touching the rest of the list.
// Much cheaper than re-rendering everything on every push from the shell.
function appendEntry(entry: JsonEntry): void {
  const matchesFilter = entryMatchesFilter(entry, searchEl.value.trim().toLowerCase());
  if (!matchesFilter) { return; }

  visibleEntries.push(entry);
  updateCount();

  emptyEl.style.display = 'none';
  listEl.style.display  = 'block';

  const el = createEntryEl(entry);
  listEl.appendChild(el);

  // Auto-scroll to the new entry only if we're already near the bottom,
  // so we don't hijack the user's scroll position mid-inspection.
  const sc = listEl.parentElement!;
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
  if (nearBottom) { el.scrollIntoView({ block: 'nearest' }); }
}

function updateCount(): void {
  const total   = allEntries.length;
  const visible = visibleEntries.length;
  countEl.textContent = visible < total
    ? `${visible} / ${total}`
    : String(total);
}

// ── Filtering ──────────────────────────────────────────────────────────────

// Returns true if the entry's payload serialises to something that includes
// the query string. Case-insensitive, checks the full JSON text.
function entryMatchesFilter(entry: JsonEntry, query: string): boolean {
  if (!query) { return true; }
  try {
    return JSON.stringify(entry.payload).toLowerCase().includes(query);
  } catch {
    return false;
  }
}

function applyFilter(): void {
  const q = searchEl.value.trim().toLowerCase();
  visibleEntries = allEntries.filter(e => entryMatchesFilter(e, q));
  renderList();
}

// ── Message handling ───────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const msg = event.data as ExtToWebview;

  switch (msg.type) {
    case 'init':
      // Full state sync on panel open — replace everything.
      allEntries     = msg.entries;
      visibleEntries = allEntries.filter(e => entryMatchesFilter(e, searchEl.value.trim().toLowerCase()));
      expandedId     = null;
      renderList();
      break;

    case 'add':
      allEntries.push(msg.entry);
      appendEntry(msg.entry);
      break;

    case 'clear':
      allEntries     = [];
      visibleEntries = [];
      expandedId     = null;
      highlightedId  = null;
      renderList();
      break;

    case 'scrollTo': {
      // Extension asked us to bring a specific entry into view and highlight it.
      highlightedId = msg.id;

      // If the entry isn't in the visible set (filtered out), clear the filter first.
      if (!visibleEntries.find(e => e.id === msg.id)) {
        searchEl.value = '';
        applyFilter();
      }

      const target = listEl.querySelector(`[data-id="${msg.id}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlighted');
        // Remove the highlight after a beat so it doesn't linger forever.
        setTimeout(() => target.classList.remove('highlighted'), 2000);
      }
      break;
    }
  }
});

// ── Wire up controls ───────────────────────────────────────────────────────

searchEl.addEventListener('input', applyFilter);

clearBtn.addEventListener('click', () => {
  // Tell the extension to clear its buffer too, not just the UI.
  // The extension will bounce back a 'clear' message that resets our state.
  vscode.postMessage({ type: 'ready' }); // triggers re-init with empty array
  // Optimistically clear locally so the panel feels instant.
  allEntries     = [];
  visibleEntries = [];
  expandedId     = null;
  highlightedId  = null;
  renderList();
});

// ── Boot ───────────────────────────────────────────────────────────────────

// Show the empty state immediately on boot so the panel isn't just a blank
// white box while waiting for 'init' to arrive from the extension host.
emptyEl.style.display = 'flex';
listEl.style.display  = 'none';

// Tell the extension the webview is alive and ready to receive 'init'.
// The extension buffers all payloads that arrived before the panel existed
// and sends them in one 'init' message once it sees this.
vscode.postMessage({ type: 'ready' });