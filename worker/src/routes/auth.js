import { HttpError, redirect, getCookie, setCookie, sign, verify, b64url } from '../util.js';
import { authUrl, exchangeCode, saveAccount } from '../google.js';
import { logActivity } from '../activity.js';

const SESSION = 'ch_session';
const NONCE = 'ch_oauth';
const WEEK = 7 * 24 * 3600;

export async function session(request, env) {
  const s = await verify(getCookie(request, SESSION), env.SESSION_SECRET);
  if (!s) return null;
  // Re-check the allowlist on every request so removing an admin takes effect immediately.
  return admins(env).includes(s.email) ? s : null;
}

export async function requireAdmin(request, env) {
  const s = await session(request, env);
  if (!s) throw new HttpError(401, 'sign in required');
  return s;
}

const admins = (env) => (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

async function start(env, purpose, extra = {}) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const state = await sign({ p: purpose, n: nonce, exp: Date.now() + 10 * 60_000, ...extra }, env.SESSION_SECRET);
  return redirect(authUrl(env, { purpose, state, loginHint: extra.hint }), {
    'set-cookie': setCookie(NONCE, nonce, { maxAge: 600, path: '/auth' }),
  });
}

export async function handleAuth(request, env, url) {
  const route = url.pathname.slice('/auth/'.length);

  if (route === 'login') {
    const next = url.searchParams.get('next');
    return start(env, 'login', { next: next && next.startsWith('/') && !next.startsWith('//') ? next : '/admin' });
  }

  if (route === 'connect') {
    await requireAdmin(request, env);
    const account = url.searchParams.get('account');
    if (!['storage', 'classroom'].includes(account)) throw new HttpError(400, 'unknown account');
    return start(env, account, { hint: url.searchParams.get('hint') || undefined });
  }

  if (route === 'logout' && request.method === 'POST') {
    return new Response(null, { status: 204, headers: { 'set-cookie': setCookie(SESSION, '', { maxAge: 0 }) } });
  }

  if (route === 'callback') {
    const err = url.searchParams.get('error');
    if (err) return page(env, 'Sign-in cancelled', `Google returned “${err}”.`);
    const state = await verify(url.searchParams.get('state'), env.SESSION_SECRET);
    if (!state || state.n !== getCookie(request, NONCE)) return page(env, 'Sign-in expired', 'That sign-in link is stale. Try again.');
    const t = await exchangeCode(env, url.searchParams.get('code'));
    if (!t.emailVerified) return page(env, 'Not allowed', 'This Google account has no verified email.');
    const clear = setCookie(NONCE, '', { maxAge: 0, path: '/auth' });

    if (state.p === 'login') {
      if (!admins(env).includes(t.email)) {
        return page(env, 'Not an admin', `${t.email} isn’t on the admin list for this site.`, 403);
      }
      const cookie = await sign({ email: t.email, name: t.name, exp: Date.now() + WEEK * 1000 }, env.SESSION_SECRET);
      await logActivity(env, t.email, 'signed in');
      const headers = new Headers({ location: state.next || '/admin' });
      headers.append('set-cookie', setCookie(SESSION, cookie, { maxAge: WEEK }));
      headers.append('set-cookie', clear);
      return new Response(null, { status: 302, headers });
    }

    const admin = await session(request, env);
    if (!admin) return page(env, 'Sign in first', 'Your admin session ended while connecting. Sign in and try again.', 401);

    if (state.p === 'storage') {
      // The library folder must be writable by this account, or every sync would fail.
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${env.DRIVE_ROOT_ID}?fields=name,capabilities(canAddChildren)&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${t.access_token}` } });
      const f = res.ok ? await res.json() : null;
      if (!f?.capabilities?.canAddChildren) {
        return page(env, 'Wrong account', `${t.email} can’t write to the library folder. Connect the Google account that owns it.`, 403);
      }
    }
    await saveAccount(env, state.p, t);
    await logActivity(env, admin.email, `connected ${state.p} account`, t.email);
    return redirect('/admin#/settings', { 'set-cookie': clear });
  }

  throw new HttpError(404, 'not found');
}

function page(env, title, message, status = 400) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/css/site.css">
<main class="notice"><p class="eyebrow">${esc(env.SITE_NAME || 'Course Materials')}</p><h1>${esc(title)}</h1><p>${esc(message)}</p>
<p><a href="/admin">Back to the dashboard</a></p></main>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
