// Small helpers shared by every route: responses, cookies, encoding, crypto.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers || {}) },
  });

export const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });

export async function readJson(request) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'expected application/json');
  try { return await request.json(); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// --- cookies -----------------------------------------------------------------
export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export const setCookie = (name, value, { maxAge, path = '/', httpOnly = true } = {}) =>
  [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'Secure', 'SameSite=Lax', httpOnly && 'HttpOnly',
    maxAge !== undefined && `Max-Age=${maxAge}`].filter(Boolean).join('; ');

// --- base64url ---------------------------------------------------------------
export const b64url = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const enc = new TextEncoder();
const dec = new TextDecoder();

// --- HMAC-signed tokens (sessions, OAuth state) --------------------------------
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sign(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
  if (!ok) return null;
  const payload = JSON.parse(dec.decode(unb64url(body)));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- AES-GCM for refresh tokens at rest --------------------------------------
async function aesKey(b64) {
  const raw = unb64url(b64);
  if (raw.length !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64/base64url encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(text, keyB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), enc.encode(text));
  return `${b64url(iv)}.${b64url(ct)}`;
}

export async function decrypt(blob, keyB64) {
  const [iv, ct] = blob.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, await aesKey(keyB64), unb64url(ct));
  return dec.decode(pt);
}

// --- gzip (catalog storage) ------------------------------------------------------
export async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// --- misc -------------------------------------------------------------------
export const nowIso = () => new Date().toISOString();

const TYPES = {
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8', cpp: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
  cir: 'text/plain; charset=utf-8', net: 'text/plain; charset=utf-8', out: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json', html: 'text/plain; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'text/plain; charset=utf-8',
  mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
// HTML and SVG are served as text so an uploaded file can never run script on our origin.
export const contentType = (path) => TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

export const disposition = (kind, filename) =>
  `${kind}; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
