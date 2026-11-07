// Shared helpers for the public site and the dashboard. No framework.

// --- safe templating -------------------------------------------------------
// Every interpolated value is escaped unless wrapped in raw(). File names come
// from Drive, so nothing user-controlled ever reaches innerHTML unescaped.
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: String(s) });
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const render = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
};
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = render(tpl); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// --- formatting ---------------------------------------------------------------
export function bytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function day(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 45 ? `${d} days ago` : day(iso);
}
export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// --- file kinds -----------------------------------------------------------------
const KIND = {
  pdf: 'pdf', ppt: 'slides', pptx: 'slides', key: 'slides', doc: 'doc', docx: 'doc', txt: 'doc', md: 'doc', rtf: 'doc',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', c: 'code', cpp: 'code', h: 'code', java: 'code', py: 'code', js: 'code',
  html: 'code', json: 'code', ipynb: 'code', cir: 'code', asc: 'code', net: 'code', jpg: 'media', jpeg: 'media',
  png: 'media', gif: 'media', webp: 'media', mp4: 'media', mp3: 'media', zip: 'other', rar: 'other',
};
export const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
export const kindOf = (name) => KIND[extOf(name)] || 'other';
export const TEXT_EXT = new Set(['c', 'cpp', 'h', 'java', 'py', 'js', 'txt', 'md', 'csv', 'cir', 'net', 'out', 'html', 'json', 'asc', 'lib', 'prb', 'als']);
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
export const tag = (name) => html`<span class="tag" data-k="${kindOf(name)}">${(extOf(name) || 'file').slice(0, 4)}</span>`;

export const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// --- icons (1.6px stroke, 24 grid) ---------------------------------------------
const P = {
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  share: '<path d="M12 15V4m0 0L8 8m4-4 4 4"/><path d="M6 11H5v9h14v-9h-1"/>',
  external: '<path d="M14 4h6v6m0-6-9 9"/><path d="M18 14v5H5V6h5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  github: '<path d="M9 19c-4.5 1.4-4.5-2.2-6.3-2.7m12.6 4.5v-3.5a3 3 0 0 0-.9-2.4c2.9-.3 6-1.4 6-6.4a5 5 0 0 0-1.4-3.5 4.6 4.6 0 0 0-.1-3.4s-1.1-.4-3.6 1.3a12.4 12.4 0 0 0-6.5 0C6.3 1.6 5.2 2 5.2 2a4.6 4.6 0 0 0-.1 3.4 5 5 0 0 0-1.4 3.5c0 5 3.1 6.1 6 6.4a3 3 0 0 0-.9 2.4v3.5"/>',
  drive: '<path d="m8.5 4 7 0 6 10.5-3.5 6h-12L2.5 14.5 8.5 4Z"/><path d="m8.5 4 6 10.5H2.5m13-10.5L9.5 14.5m12 0-3.5 6"/>',
  folder: '<path d="M3 6.5V18a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1h-8L10 5H4a1 1 0 0 0-1 1.5Z"/>',
  file: '<path d="M14 3H6v18h12V7l-4-4Z"/><path d="M14 3v4h4"/>',
  upload: '<path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5M5 19h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.5 4.5L20 16m0 4v-4h-4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
export const icon = (name) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`);

// --- toast ------------------------------------------------------------------------
let toastTimer;
export function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.append(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  }
}

// --- theme ------------------------------------------------------------------------
export function initTheme(button) {
  const get = () => { try { return localStorage.getItem('theme'); } catch { return null; } };
  const set = (v) => { try { localStorage.setItem('theme', v); } catch { /* private mode */ } };
  const apply = (t) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    if (button) { button.innerHTML = render(icon(dark ? 'sun' : 'moon')); button.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme'); }
  };
  apply(get());
  button?.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    set(next); apply(next);
  });
}
