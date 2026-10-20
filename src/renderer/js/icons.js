// Line icons (24px grid, drawn for FlowCut) and the logo. <span data-icon="name"> and <span data-logo> are filled in.
const PATHS = {
  folder: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  export: 'M12 15V4M8 8l4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14',
  render: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM10 9l5 3-5 3z',
  chevron: 'M7 10l5 5 5-5',
  prev: 'M6 5v14M18 6l-9 6 9 6z',
  next: 'M18 5v14M6 6l9 6-9 6z',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.4M12 17h.01',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.5 7.5L20 18M8.5 16.5L20 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  text: 'M4 6h16M4 10h16M4 14h10M4 18h7',
  volume: 'M4 9.5h3l4.5-3.8v12.6L7 14.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  close: 'M6 6l12 12M18 6L6 18',
};
const FILLED = {
  play: 'M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
};

export function icon(name) {
  if (FILLED[name]) return `<svg class="icon" viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><path d="${FILLED[name]}"/></svg>`;
  return `<svg class="icon" viewBox="0 0 24 24"><path d="${PATHS[name] || ''}"/></svg>`;
}

let logoSeq = 0;
/** The app icon (same artwork as build/icon.svg); 'small' is the simplified version for 16-32 px. */
export function logo(variant = 'large') {
  const id = `fcg${++logoSeq}`;
  if (variant === 'small') {
    return `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d6347"/><stop offset="1" stop-color="#0a2219"/></linearGradient></defs>
      <rect x="1" y="1" width="30" height="30" rx="7" fill="url(#${id})"/>
      <g fill="#8ff0bc"><rect x="5" y="12" width="3" height="8" rx="1.5"/><rect x="9.5" y="8" width="3" height="16" rx="1.5"/>
      <rect x="19.5" y="9" width="3" height="14" rx="1.5"/><rect x="24" y="13" width="3" height="6" rx="1.5"/></g>
      <rect x="15" y="6" width="2" height="20" rx="1" fill="#ff6f5e"/>
    </svg>`;
  }
  return `<svg class="logo" viewBox="0 0 256 256" aria-hidden="true">
    <defs>
      <linearGradient id="${id}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a5a40"/><stop offset="0.55" stop-color="#0e3426"/><stop offset="1" stop-color="#071a13"/></linearGradient>
      <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8ffd6"/><stop offset="1" stop-color="#45c486"/></linearGradient>
      <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9b7a"/><stop offset="1" stop-color="#ff5d55"/></linearGradient>
    </defs>
    <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#${id}t)"/>
    <rect x="9" y="9" width="238" height="238" rx="55" fill="none" stroke="#7fe3ad" stroke-opacity="0.22" stroke-width="2"/>
    <g fill="url(#${id}b)"><rect x="40" y="103" width="18" height="50" rx="9"/><rect x="68" y="76" width="18" height="104" rx="9"/>
    <rect x="96" y="54" width="18" height="148" rx="9"/><rect x="142" y="62" width="18" height="132" rx="9"/>
    <rect x="170" y="86" width="18" height="84" rx="9"/><rect x="198" y="108" width="18" height="40" rx="9"/></g>
    <path d="M116 44 L140 44 L128 60 Z M116 212 L140 212 L128 196 Z" fill="url(#${id}c)"/>
    <rect x="126" y="66" width="4" height="124" rx="2" fill="#ff7a66" opacity="0.85"/>
  </svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
  root.querySelectorAll('[data-logo]').forEach((el) => { el.outerHTML = logo(el.dataset.logo || 'large'); });
}

export function setIcon(button, name) {
  const svg = button.querySelector('svg.icon');
  if (svg) svg.outerHTML = icon(name);
}
