// Google OAuth + the handful of Drive calls the Worker makes itself
// (file manager actions, uploads, streaming Drive-only files).
import { HttpError, encrypt, decrypt, nowIso } from './util.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

export const SCOPES = {
  login: ['openid', 'email', 'profile'],
  storage: ['openid', 'email', 'https://www.googleapis.com/auth/drive'],
  classroom: [
    'openid', 'email',
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
    'https://www.googleapis.com/auth/classroom.announcements.readonly',
    'https://www.googleapis.com/auth/classroom.topics.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
};

export function authUrl(env, { purpose, state, loginHint }) {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_URL}/auth/callback`,
    response_type: 'code',
    scope: SCOPES[purpose].join(' '),
    state,
    ...(purpose === 'login' ? { prompt: 'select_account' } : { access_type: 'offline', prompt: 'consent' }),
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(env, params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await res.json();
  if (!res.ok) throw new HttpError(res.status === 400 ? 409 : 502, `${j.error}: ${j.error_description || ''}`.trim(), { googleError: j.error });
  return j;
}

export async function exchangeCode(env, code) {
  const t = await tokenRequest(env, { code, grant_type: 'authorization_code', redirect_uri: `${env.PUBLIC_URL}/auth/callback` });
  // The id_token comes straight from Google's token endpoint over TLS, so its
  // claims can be read without re-verifying the signature (OIDC Core 3.1.3.7).
  const claims = JSON.parse(atob(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { ...t, email: String(claims.email || '').toLowerCase(), emailVerified: claims.email_verified, name: claims.name };
}

// --- stored grants -------------------------------------------------------------
export async function saveAccount(env, account, t) {
  if (!t.refresh_token) throw new HttpError(400, 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
  await env.DB.prepare(
    `INSERT INTO accounts (account, email, scopes, refresh_enc, access_enc, access_expires, connected_at, last_error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
     ON CONFLICT(account) DO UPDATE SET email=?2, scopes=?3, refresh_enc=?4, access_enc=?5, access_expires=?6, connected_at=?7, last_error=NULL`,
  ).bind(account, t.email, t.scope, await encrypt(t.refresh_token, env.TOKEN_KEY), await encrypt(t.access_token, env.TOKEN_KEY),
    Date.now() + t.expires_in * 1000, nowIso()).run();
}

export async function accountInfo(env, account) {
  return env.DB.prepare('SELECT account, email, scopes, connected_at, last_error FROM accounts WHERE account = ?').bind(account).first();
}

/** A valid access token for a stored grant, refreshing it when needed. */
export async function accessToken(env, account) {
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE account = ?').bind(account).first();
  if (!row) throw new HttpError(409, `${account} account is not connected`);
  const open = async (blob) => {
    try { return await decrypt(blob, env.TOKEN_KEY); } catch {
      const msg = `The stored ${account} grant can't be decrypted (was TOKEN_KEY changed?). Reconnect it in Settings.`;
      await env.DB.prepare('UPDATE accounts SET last_error = ? WHERE account = ?').bind(msg, account).run();
      throw new HttpError(409, msg);
    }
  };
  if (row.access_enc && row.access_expires - Date.now() > 5 * 60_000) {
    return { token: await open(row.access_enc), expiresAt: row.access_expires };
  }
  const refreshToken = await open(row.refresh_enc);
  try {
    const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken });
    const expiresAt = Date.now() + t.expires_in * 1000;
    await env.DB.prepare('UPDATE accounts SET access_enc = ?, access_expires = ?, last_error = NULL WHERE account = ?')
      .bind(await encrypt(t.access_token, env.TOKEN_KEY), expiresAt, account).run();
    return { token: t.access_token, expiresAt };
  } catch (e) {
    const msg = e.extra?.googleError === 'invalid_grant'
      ? 'Google revoked or expired this grant. Reconnect it in Settings (if the OAuth app is in "Testing" mode, tokens expire after 7 days; publish it).'
      : e.message;
    await env.DB.prepare('UPDATE accounts SET last_error = ? WHERE account = ?').bind(msg, account).run();
    throw new HttpError(409, msg);
  }
}

// --- Drive -------------------------------------------------------------------------
export class Drive {
  constructor(env) { this.env = env; }

  async req(url, init = {}) {
    const { token } = await accessToken(this.env, 'storage');
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    if (!res.ok && !init.raw) {
      const body = await res.text();
      throw new HttpError(res.status === 404 ? 404 : 502, `Drive: ${res.status} ${body.slice(0, 200)}`);
    }
    return init.raw ? res : res.status === 204 ? null : res.json();
  }

  get(id, fields = 'id,name,mimeType,size,modifiedTime,parents,capabilities(canAddChildren,canEdit)') {
    return this.req(`${DRIVE}/files/${id}?fields=${fields}&supportsAllDrives=true`);
  }

  async children(id) {
    const out = [];
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${id}' in parents and trashed = false`);
      const j = await this.req(`${DRIVE}/files?q=${q}&pageSize=1000&orderBy=folder,name_natural` +
        `&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`);
      out.push(...j.files);
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  /** Resolve "A/B/C" under the library root to a folder id (optionally creating it). */
  async resolve(path, { create = false } = {}) {
    let id = this.env.DRIVE_ROOT_ID;
    for (const name of path.split('/').filter(Boolean)) {
      const q = encodeURIComponent(`'${id}' in parents and trashed = false and mimeType = '${FOLDER}' and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
      const j = await this.req(`${DRIVE}/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      if (j.files.length) id = j.files[0].id;
      else if (create) id = (await this.mkdir(name, id)).id;
      else throw new HttpError(404, `folder not found: ${path}`);
    }
    return id;
  }

  mkdir(name, parentId) {
    return this.req(`${DRIVE}/files?fields=id,name&supportsAllDrives=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
    });
  }

  /** Stream an upload straight from the incoming request body (no buffering). */
  async upload(name, parentId, body, { mime, size }) {
    const init = await this.req(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime || 'application/octet-stream',
        ...(size ? { 'x-upload-content-length': String(size) } : {}),
      },
      body: JSON.stringify({ name, parents: [parentId] }),
      raw: true,
    });
    if (!init.ok) throw new HttpError(502, `Drive upload init: ${init.status} ${(await init.text()).slice(0, 200)}`);
    // A plain stream body would go out chunked; Drive wants a known length.
    let payload = body;
    if (size && body instanceof ReadableStream) {
      const { readable, writable } = new FixedLengthStream(size);
      body.pipeTo(writable).catch(() => {});
      payload = readable;
    }
    const res = await fetch(init.headers.get('location'), {
      method: 'PUT', body: payload, headers: { 'content-type': mime || 'application/octet-stream' },
    });
    if (!res.ok) throw new HttpError(502, `Drive upload: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async move(id, { name, toParent }) {
    const cur = await this.get(id, 'id,parents');
    const qs = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,parents' });
    if (toParent && !cur.parents.includes(toParent)) { qs.set('addParents', toParent); qs.set('removeParents', cur.parents.join(',')); }
    return this.req(`${DRIVE}/files/${id}?${qs}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(name ? { name } : {}),
    });
  }

  trash(id) {
    return this.req(`${DRIVE}/files/${id}?supportsAllDrives=true&fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
  }

  /** Raw media response (Range passes through), for streaming Drive-only files. */
  media(id, range) {
    return this.req(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, { raw: true, headers: range ? { range } : {} });
  }
}
