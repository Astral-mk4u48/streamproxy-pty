// Renders an unknown JSON value as a collapsible tree of DOM nodes.
// No framework, no dependencies — just returns an HTMLElement you can
// drop anywhere. Collapsed state is stored on the element itself so
// re-rendering a single entry doesn't blow away expand state on others.

const COLORS = {
  key:    'var(--sp-key)',
  string: 'var(--sp-string)',
  number: 'var(--sp-number)',
  bool:   'var(--sp-bool)',
  null:   'var(--sp-null)',
  brace:  'var(--sp-brace)',
  dim:    'var(--sp-dim)',
};

function span(text: string, color: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  el.style.color = color;
  return el;
}

function toggle(arrow: HTMLElement, children: HTMLElement, collapsed: boolean): void {
  arrow.textContent   = collapsed ? '▶' : '▼';
  children.style.display = collapsed ? 'none' : 'block';
}

// Render a single value node. `depth` controls indentation.
function renderValue(value: unknown, depth: number, collapsed = false): HTMLElement {
  const wrapper = document.createElement('span');

  if (value === null) {
    wrapper.appendChild(span('null', COLORS.null));
    return wrapper;
  }

  if (typeof value === 'string') {
    wrapper.appendChild(span(`"${value}"`, COLORS.string));
    return wrapper;
  }

  if (typeof value === 'number') {
    wrapper.appendChild(span(String(value), COLORS.number));
    return wrapper;
  }

  if (typeof value === 'boolean') {
    wrapper.appendChild(span(String(value), COLORS.bool));
    return wrapper;
  }

  if (Array.isArray(value)) {
    return renderCollection(value, depth, '[', ']', collapsed);
  }

  if (typeof value === 'object') {
    return renderCollection(value as Record<string, unknown>, depth, '{', '}', collapsed);
  }

  wrapper.appendChild(span(String(value), COLORS.dim));
  return wrapper;
}

function renderCollection(
  value: unknown[] | Record<string, unknown>,
  depth: number,
  open: string,
  close: string,
  startCollapsed: boolean
): HTMLElement {
  const isArray  = Array.isArray(value);
  const entries  = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const wrapper  = document.createElement('span');

  // Empty collection — render inline, nothing to toggle.
  if (entries.length === 0) {
    wrapper.appendChild(span(open + close, COLORS.brace));
    return wrapper;
  }

  // Arrow + opening brace on the same line.
  const header = document.createElement('span');
  header.style.cursor = 'pointer';
  header.style.userSelect = 'none';

  const arrow = document.createElement('span');
  arrow.style.cssText = `
    display: inline-block;
    width: 1em;
    font-size: 0.65em;
    vertical-align: middle;
    color: ${COLORS.dim};
    margin-right: 2px;
  `;

  const preview = document.createElement('span');
  preview.style.color = COLORS.dim;
  preview.style.fontSize = '0.85em';

  header.appendChild(arrow);
  header.appendChild(span(open, COLORS.brace));

  // Child rows — each key: value on its own indented line.
  const children = document.createElement('div');
  children.style.paddingLeft = '1.2em';
  children.style.borderLeft  = '1px solid var(--sp-indent-guide)';
  children.style.marginLeft  = '0.3em';

  for (const [k, v] of entries) {
    const row = document.createElement('div');

    if (!isArray) {
      row.appendChild(span(`"${k}"`, COLORS.key));
      row.appendChild(span(': ', COLORS.dim));
    }

    // Start child objects/arrays collapsed so deep trees don't flood the panel.
    row.appendChild(renderValue(v, depth + 1, depth >= 1));
    children.appendChild(row);
  }

  const count = entries.length;
  preview.textContent = ` ${count} ${isArray ? 'item' : 'key'}${count !== 1 ? 's' : ''} `;
  header.appendChild(preview);
  header.appendChild(span(close, COLORS.brace));

  // Collapse/expand on click.
  let isCollapsed = startCollapsed;
  toggle(arrow, children, isCollapsed);

  header.addEventListener('click', (e) => {
    e.stopPropagation();
    isCollapsed = !isCollapsed;
    toggle(arrow, children, isCollapsed);
    // Hide the count preview when expanded — it's redundant.
    preview.style.display = isCollapsed ? 'inline' : 'none';
  });

  wrapper.appendChild(header);
  wrapper.appendChild(children);
  return wrapper;
}

// Public entry point. Returns a fully rendered tree for `payload`.
export function renderJsonTree(payload: unknown): HTMLElement {
  const root = document.createElement('div');
  root.className = 'json-tree';
  root.appendChild(renderValue(payload, 0, false));
  return root;
}
