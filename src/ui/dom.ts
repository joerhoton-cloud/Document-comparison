type Child = Node | string | number | false | null | undefined;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/**
 * Minimal element factory. Text is always inserted as text nodes, never parsed
 * as HTML, so document content can't inject markup into the page.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Inline SVG icons (static markup, no user content). */
const ICONS: Record<string, string> = {
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 16v4h16v-4',
  swap: 'M7 7h13l-4-4M17 17H4l4 4',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  download: 'M12 4v12m0 0-5-5m5 5 5-5M4 20h16',
  back: 'M15 18l-6-6 6-6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  x: 'M6 6l12 12M18 6 6 18',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}
