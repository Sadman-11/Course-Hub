// Minimal Google Drive + OAuth client for the sync job (Node 20+, no deps).
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,md5Checksum,size,modifiedTime,createdTime,parents';

// Google-native types and how they are mirrored to Git (read-only exports).
export const EXPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx',
  },
};

/**
 * Access-token source. Prefers the Worker's token broker (so refresh tokens
 * live in one place); falls back to a refresh token in the environment.
 */
export function tokenSource(account, env = process.env) {
  let cached = null;
  return async function getToken() {
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    if (env.SYNC_API && env.SYNC_TOKEN) {
      const r = await fetch(`${env.SYNC_API.replace(/\/$/, '')}/api/internal/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.SYNC_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ account }),
      });
      if (!r.ok) throw new Error(`token broker (${account}): ${r.status} ${await r.text()}`);
      const j = await r.json();
      cached = { token: j.access_token, expiresAt: j.expires_at };
      return cached.token;
    }
    const refresh = account === 'classroom'
      ? env.CLASSROOM_REFRESH_TOKEN || env.GOOGLE_REFRESH_TOKEN
      : env.GOOGLE_REFRESH_TOKEN;
    if (!refresh || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new Error(`no credentials for "${account}": set SYNC_API+SYNC_TOKEN or GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`);
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refresh, grant_type: 'refresh_token',
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`refresh (${account}): ${j.error} ${j.error_description || ''}`);
    cached = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return cached.token;
  };
}

export class Drive {
  constructor(getToken) {
    this.getToken = getToken;
  }

  async req(url, init = {}, { retries = 5, raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        ...init,
        headers: { authorization: `Bearer ${await this.getToken()}`, ...(init.headers || {}) },
      });
      if (res.ok) return raw ? res : res.status === 204 ? null : res.json();
      const body = await res.text();
      const retryable = res.status === 429 || res.status >= 500 ||
        (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body));
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 400));
        continue;
      }
      const err = new Error(`Drive ${init.method || 'GET'} ${url.split('?')[0]} → ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
  }

  async get(id, fields = FILE_FIELDS) {
    return this.req(`${DRIVE}/files/${id}?fields=${fields}&supportsAllDrives=true`);
  }

  async children(folderId) {
    const out = [];
    let pageToken;
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const u = `${DRIVE}/files?q=${q}&pageSize=1000&fields=nextPageToken,files(${FILE_FIELDS})` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await this.req(u);
      out.push(...j.files);
      pageToken = j.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * Walk the tree under rootId. Returns { files: Map<path, entry>, folders: Map<path, id>, issues[] }.
   * Paths are "/"-joined names; "/" inside a Drive name becomes "-".
   */
  async tree(rootId, { concurrency = 8 } = {}) {
    const files = new Map();
    const folders = new Map([['', rootId]]);
    const issues = [];
    let frontier = [['', rootId]];
    while (frontier.length) {
      const next = [];
      const results = await mapLimit(frontier, concurrency, ([p, id]) => this.children(id));
      frontier.forEach(([parentPath], i) => {
        const seen = new Map();
        // Newest first, so on a name clash the newest file wins.
        for (const f of results[i].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))) {
          const clean = f.name.replace(/\//g, '-').trim();
          if (!clean || clean === '.git') { issues.push({ type: 'bad-name', path: `${parentPath}/${f.name}`, id: f.id }); continue; }
          if (f.mimeType === FOLDER) {
            const p = parentPath ? `${parentPath}/${clean}` : clean;
            if (folders.has(p)) issues.push({ type: 'duplicate-folder', path: p, id: f.id });
            else { folders.set(p, f.id); next.push([p, f.id]); }
            continue;
          }
          const exp = EXPORTS[f.mimeType];
          if (f.mimeType.startsWith('application/vnd.google-apps.') && !exp) {
            issues.push({ type: 'unsupported-google-type', path: `${parentPath}/${clean}`, mime: f.mimeType });
            continue;
          }
          const name = exp && !clean.toLowerCase().endsWith(`.${exp.ext}`) ? `${clean}.${exp.ext}` : clean;
          const p = parentPath ? `${parentPath}/${name}` : name;
          const key = p.toLowerCase();
          if (seen.has(key)) { issues.push({ type: 'name-clash', path: p, kept: seen.get(key), skipped: f.id }); continue; }
          seen.set(key, f.id);
          files.set(p, {
            id: f.id, md5: f.md5Checksum || null, size: Number(f.size || 0), mime: f.mimeType,
            mtime: f.modifiedTime, ctime: f.createdTime, export: exp || null,
          });
        }
      });
      frontier = next;
    }
    return { files, folders, issues };
  }

  /** Stream a file's bytes (or its export) to dest. */
  async download(entry, dest) {
    const base = entry.export
      ? `${DRIVE}/files/${entry.id}/export?mimeType=${encodeURIComponent(entry.export.mime)}`
      : `${DRIVE}/files/${entry.id}?alt=media&supportsAllDrives=true`;
    let res;
    try {
      res = await this.req(base, {}, { raw: true });
    } catch (e) {
      // Drive flags some files (e.g. zips) as "abusive"; the owner may still fetch them.
      if (e.status === 403 && /cannotDownloadAbusiveFile/.test(e.body || '')) {
        res = await this.req(`${base}&acknowledgeAbuse=true`, {}, { raw: true });
      } else throw e;
    }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  }

  async createFolder(name, parentId) {
    return this.req(`${DRIVE}/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
    });
  }

  /** Make sure every folder of `dirPath` exists; returns the leaf folder id. */
  async ensureFolder(dirPath, folders) {
    if (folders.has(dirPath)) return folders.get(dirPath);
    const parts = dirPath.split('/');
    let cur = '';
    let id = folders.get('');
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!folders.has(cur)) folders.set(cur, (await this.createFolder(part, id)).id);
      id = folders.get(cur);
    }
    return id;
  }

  /** Resumable upload of a Buffer as a new file. */
  async upload(name, parentId, buf, mime = 'application/octet-stream') {
    const init = await this.req(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime },
      body: JSON.stringify({ name, parents: [parentId] }),
    }, { raw: true });
    return this.req(init.headers.get('location'), { method: 'PUT', headers: { 'content-type': mime }, body: buf });
  }

  async updateContent(id, buf, mime = 'application/octet-stream') {
    return this.req(`${UPLOAD}/files/${id}?uploadType=media&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: 'PATCH', headers: { 'content-type': mime }, body: buf,
    });
  }

  async move(id, { name, addParent, removeParent } = {}) {
    const qs = new URLSearchParams({ supportsAllDrives: 'true', fields: FILE_FIELDS });
    if (addParent && addParent !== removeParent) { qs.set('addParents', addParent); qs.set('removeParents', removeParent); }
    return this.req(`${DRIVE}/files/${id}?${qs}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(name ? { name } : {}),
    });
  }

  async trash(id) {
    return this.req(`${DRIVE}/files/${id}?supportsAllDrives=true&fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
  }

  async copy(id, name, parentId) {
    return this.req(`${DRIVE}/files/${id}/copy?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parents: [parentId] }),
    });
  }
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}
