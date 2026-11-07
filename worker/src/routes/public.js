// Public site: catalog API, file bytes, and SPA pages with link-preview tags.
import { HttpError, json, contentType, disposition } from '../util.js';
import { loadCatalog, getMeta } from '../catalog.js';
import { rawFile } from '../github.js';
import { Drive } from '../google.js';

export async function catalogResponse(request, env) {
  const cat = await loadCatalog(env);
  if (!cat) return json({ files: [], meta: await getMeta(env), empty: true }, { headers: { 'cache-control': 'public, max-age=30' } });
  const meta = await getMeta(env);
  const etag = `W/"${cat.doc.commit}-${cat.doc.generated}-${JSON.stringify(meta).length}"`;
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
  return json({
    site: env.SITE_NAME, repo: env.GITHUB_REPO, commit: cat.doc.commit, generated: cat.doc.generated,
    files: cat.doc.files.map(([p, size, mtime, ctime, id, sha]) => [p, size, mtime, ctime, id, sha ? 1 : 0]),
    meta,
  }, { headers: { etag, 'cache-control': 'public, max-age=60, stale-while-revalidate=600' } });
}

export async function statusResponse(env) {
  const r = await env.DB.prepare(
    "SELECT status, finished FROM runs WHERE status IN ('ok','partial') ORDER BY finished DESC LIMIT 1").first();
  return json({ lastSync: r?.finished || null, status: r?.status || null }, { headers: { 'cache-control': 'public, max-age=60' } });
}

/**
 * /raw/<path> (inline) and /dl/<path> (download).
 * GitHub first (immutable URL at the synced commit, cached at the edge),
 * Drive as fallback and for files that are Drive-only (>100 MiB / ignored).
 */
export async function fileResponse(request, env, ctx, url, kind) {
  const path = decodeURIComponent(url.pathname.slice(kind === 'inline' ? 5 : 4));
  const cat = await loadCatalog(env);
  const row = cat?.byPath.get(path);
  if (!row) throw new HttpError(404, 'file not found');
  const [, size, mtime, , driveId, sha] = row;
  const name = path.split('/').pop();
  const type = contentType(path);
  const headers = {
    'content-type': type,
    'content-disposition': disposition(kind === 'inline' ? 'inline' : 'attachment', name),
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
    'last-modified': new Date(mtime).toUTCString(),
  };
  // HTML/SVG are already served as text/plain; sandbox text and unknown types too,
  // so nothing a user uploads can ever run script on this origin. (Not applied to
  // PDFs: Chrome's viewer refuses to render inside a sandboxed document.)
  if (type.startsWith('text/') || type === 'application/octet-stream') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  const range = request.headers.get('range');

  if (sha && !range) {
    const cache = caches.default;
    const key = new Request(`https://blob.cache/${sha}/${encodeURIComponent(path)}`);
    let res = await cache.match(key);
    if (!res) {
      const upstream = await rawFile(env, cat.doc.commit, path);
      if (!upstream.ok) console.warn(`github raw ${upstream.status}: ${path}`);
      if (upstream.ok) {
        res = new Response(upstream.body, { headers: { 'content-length': upstream.headers.get('content-length') || String(size), 'cache-control': 'public, max-age=31536000, immutable' } });
        ctx.waitUntil(cache.put(key, res.clone()));
      }
    }
    if (res) return new Response(res.body, { headers: { ...headers, 'content-length': res.headers.get('content-length') || String(size), etag: `"${sha}"`, 'x-served-from': 'github' } });
  }

  // Drive: Drive-only files, Range requests (video seeking) and GitHub failures.
  const upstream = await new Drive(env).media(driveId, range);
  if (!upstream.ok && upstream.status !== 206) throw new HttpError(502, `Drive returned ${upstream.status}`);
  const out = new Headers(headers);
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.get(h)) out.set(h, upstream.headers.get(h));
  out.set('x-served-from', 'drive');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/** SPA shell with per-page <title> and Open Graph tags for chat link previews. */
export async function pageResponse(request, env, url) {
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  const site = env.SITE_NAME || 'Course Materials';
  let title = site;
  let description = 'Lecture slides, lab manuals, question papers and books, organised by course and instructor.';
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  if (parts[0] === 'f' && parts.length > 2) {
    title = `${parts[parts.length - 1]} · ${parts[1]}`;
    description = `${parts.slice(1, -1).join(' / ')} — ${site}`;
  } else if (parts[0] === 'c' && parts[1]) {
    const meta = await getMeta(env);
    const course = parts[1].toUpperCase();
    title = `${course}${meta.courses[course] ? ` · ${meta.courses[course]}` : ''} — ${site}`;
    if (parts[2]) description = `Materials from ${meta.instructors[parts[2]] || parts[2]} for ${course}.`;
  }
  const content = (value) => ({ element: (el) => el.setAttribute('content', value) });
  return new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(title) })
    .on('meta[property="og:title"]', content(title))
    .on('meta[property="og:description"]', content(description))
    .on('meta[name="description"]', content(description))
    .on('meta[property="og:url"]', content(url.href))
    .transform(new Response(shell.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } }));
}
