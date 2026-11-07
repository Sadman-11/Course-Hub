// Course Hub Worker: public library site, admin dashboard API, OAuth,
// token broker for the sync job, and a cron that keeps the sync running.
import { HttpError, json, redirect } from './util.js';
import { handleAuth, session } from './routes/auth.js';
import { handleAdmin } from './routes/admin.js';
import { handleInternal } from './routes/internal.js';
import { catalogResponse, statusResponse, fileResponse, pageResponse } from './routes/public.js';
import { dispatchSync } from './github.js';

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://*.googleusercontent.com https://drive.google.com",
  "frame-src 'self' https://drive.google.com https://docs.google.com",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function withPageHeaders(res) {
  const h = new Headers(res.headers);
  h.set('content-security-policy', PAGE_CSP);
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-content-type-options', 'nosniff');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(res.body, { status: res.status, headers: h });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.startsWith('/api/internal/')) return handleInternal(request, env, url);
  if (path.startsWith('/api/admin/')) return handleAdmin(request, env, url, ctx);
  if (path.startsWith('/auth/')) return handleAuth(request, env, url);
  if (path === '/api/catalog') return catalogResponse(request, env);
  if (path === '/api/status') return statusResponse(env);
  if (path.startsWith('/raw/')) return fileResponse(request, env, ctx, url, 'inline');
  if (path.startsWith('/dl/')) return fileResponse(request, env, ctx, url, 'attachment');

  if (path === '/admin' || path === '/admin/') {
    if (!(await session(request, env))) return redirect('/auth/login?next=/admin');
    return withPageHeaders(await env.ASSETS.fetch(new Request(new URL('/admin', url), request)));
  }
  if (path === '/' || path.startsWith('/c/') || path.startsWith('/f/') || path === '/recent' || path === '/about') {
    return withPageHeaders(await pageResponse(request, env, url));
  }
  // Static assets (css/js/fonts). Unknown paths fall through to the SPA's 404 view.
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404 && !path.includes('.')) return withPageHeaders(await pageResponse(request, env, url));
  return asset;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e.stack || e);
      return json({ error: status === 500 ? 'internal error' : e.message }, { status });
    }
  },

  // Every 30 min: ask GitHub Actions to run the sync. Dispatches (unlike
  // `schedule:` triggers) are never paused for repo inactivity.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchSync(env, { trigger: 'cron' }).catch((e) => console.error('cron dispatch failed:', e.message)));
  },
};
