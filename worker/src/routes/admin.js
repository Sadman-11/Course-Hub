// Dashboard API. Every route requires an admin session.
import { HttpError, json, readJson, nowIso } from '../util.js';
import { requireAdmin } from './auth.js';
import { accountInfo, Drive } from '../google.js';
import { loadCatalog, getMeta, saveMeta } from '../catalog.js';
import { dispatchSync, workflowRuns } from '../github.js';
import { logActivity, recentActivity } from '../activity.js';
import { canonicalPath, CATEGORIES, semesterFromDate, cleanName } from '../../../shared/taxonomy.js';

const MAX_UPLOAD = 100 * 1024 * 1024; // Workers request-body limit

export async function handleAdmin(request, env, url, ctx) {
  const admin = await requireAdmin(request, env);
  // State-changing calls must be same-origin fetches (cookie is SameSite=Lax; this closes the gap for top-level POSTs).
  if (request.method !== 'GET' && request.headers.get('x-requested-with') !== 'course-hub') throw new HttpError(403, 'missing CSRF header');
  const route = url.pathname.slice('/api/admin'.length);
  const m = (method, pattern) => {
    if (request.method !== method) return null;
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    return re.exec(route)?.groups || (re.test(route) ? {} : null);
  };
  let p;

  if ((p = m('GET', '/me'))) return json({ email: admin.email, name: admin.name });

  if ((p = m('GET', '/overview'))) {
    const [cat, storage, classroom, lastRuns, inbox, activity] = await Promise.all([
      loadCatalog(env), accountInfo(env, 'storage'), accountInfo(env, 'classroom'),
      env.DB.prepare('SELECT id, status, trigger, started, finished, counts, plan_hash, run_url FROM runs ORDER BY started DESC LIMIT 8').all(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM classroom_items WHERE status = 'new'").first(),
      recentActivity(env, 15),
    ]);
    let gh = { runs: [], tokenExpires: null, error: null };
    try { gh = await workflowRuns(env, 5); } catch (e) { gh.error = e.message; }
    const files = cat?.doc.files || [];
    const bytes = files.reduce((s, r) => s + r[1], 0);
    const onGit = files.filter((r) => r[5]);
    return json({
      library: {
        files: files.length, bytes, onGithub: onGit.length, githubBytes: onGit.reduce((s, r) => s + r[1], 0),
        driveOnly: files.length - onGit.length, courses: new Set(files.map((r) => r[0].split('/')[0])).size,
        generated: cat?.doc.generated || null, commit: cat?.doc.commit || null,
      },
      accounts: { storage, classroom },
      runs: lastRuns.results.map((r) => ({ ...r, counts: JSON.parse(r.counts || '{}') })),
      github: gh, inbox: inbox?.n || 0, activity,
      repo: env.GITHUB_REPO, driveRoot: env.DRIVE_ROOT_ID,
    });
  }

  if ((p = m('GET', '/runs'))) {
    const { results } = await env.DB.prepare('SELECT id, status, trigger, started, finished, counts, plan_hash, run_url, commit_sha FROM runs ORDER BY started DESC LIMIT 50').all();
    return json(results.map((r) => ({ ...r, counts: JSON.parse(r.counts || '{}') })));
  }

  if ((p = m('GET', '/runs/:id'))) {
    const r = await env.DB.prepare('SELECT report FROM runs WHERE id = ?').bind(p.id).first();
    if (!r) throw new HttpError(404, 'run not found');
    return json(JSON.parse(r.report));
  }

  if ((p = m('POST', '/sync'))) {
    const body = await readJson(request);
    const approve = typeof body.approve === 'string' && /^[0-9a-f]{16}$/.test(body.approve) ? body.approve : '';
    const tokenExpires = await dispatchSync(env, { dryRun: !!body.dryRun, approve, trigger: `dashboard:${admin.email}` });
    await logActivity(env, admin.email, approve ? 'approved deletions' : body.dryRun ? 'started dry run' : 'started sync', approve || null);
    return json({ ok: true, tokenExpires });
  }

  // --- live Drive file manager --------------------------------------------------
  if ((p = m('GET', '/drive'))) {
    const path = url.searchParams.get('path') || '';
    const drive = new Drive(env);
    const id = await drive.resolve(path);
    const items = await drive.children(id);
    return json({ path, id, items: items.map((f) => ({ id: f.id, name: f.name, folder: f.mimeType.endsWith('.folder'), size: Number(f.size || 0), modified: f.modifiedTime })) });
  }

  if ((p = m('POST', '/drive/mkdir'))) {
    const { path } = await readJson(request);
    const clean = String(path || '').split('/').map((s) => cleanName(s.trim(), { isFolder: true })).filter(Boolean).join('/');
    if (!clean) throw new HttpError(400, 'path required');
    const id = await new Drive(env).resolve(clean, { create: true });
    await logActivity(env, admin.email, 'created folder', clean);
    return json({ id, path: clean });
  }

  if ((p = m('POST', '/drive/upload'))) {
    // Body is the raw file; destination folder and name in the query string.
    const dir = url.searchParams.get('dir') || '';
    const name = cleanName(url.searchParams.get('name') || '');
    const size = Number(request.headers.get('content-length') || 0);
    if (!name || !dir) throw new HttpError(400, 'dir and name required');
    if (size > MAX_UPLOAD) throw new HttpError(413, 'Files over 100 MB must be uploaded in Google Drive directly');
    const drive = new Drive(env);
    const parent = await drive.resolve(dir, { create: true });
    const f = await drive.upload(name, parent, request.body, { mime: request.headers.get('content-type'), size });
    await logActivity(env, admin.email, 'uploaded', `${dir}/${name}`);
    return json({ ok: true, file: f, path: `${dir}/${name}` });
  }

  if ((p = m('POST', '/drive/move'))) {
    const { id, toDir, name } = await readJson(request);
    const drive = new Drive(env);
    const toParent = toDir !== undefined ? await drive.resolve(toDir, { create: true }) : undefined;
    const f = await drive.move(id, { name: name ? cleanName(name) : undefined, toParent });
    await logActivity(env, admin.email, 'moved/renamed', `${f.name}${toDir !== undefined ? ` → ${toDir}` : ''}`);
    return json({ ok: true, file: f });
  }

  if ((p = m('POST', '/drive/trash'))) {
    const { id, name } = await readJson(request);
    await new Drive(env).trash(id);
    await logActivity(env, admin.email, 'trashed', name || id);
    return json({ ok: true });
  }

  if ((p = m('GET', '/suggest'))) {
    // Canonical destination for a new file: COURSE/INSTRUCTOR/Category/Semester/name
    const q = Object.fromEntries(url.searchParams);
    const course = (q.course || '').toUpperCase().replace(/\s+/g, '');
    const instructor = (q.instructor || 'General').trim();
    const semester = q.semester === 'none' ? null : q.semester || semesterFromDate(Date.now());
    const guess = canonicalPath(`${course}/${instructor}/${q.name || 'file'}`, { size: Number(q.size || 0) });
    const category = CATEGORIES.includes(q.category) ? q.category : guess.category;
    const name = cleanName(q.name || '');
    return json({ category, semester, dir: [course, instructor, category, semester].filter(Boolean).join('/'), name, categories: CATEGORIES });
  }

  // --- Classroom ---------------------------------------------------------------------
  if ((p = m('GET', '/classroom'))) {
    const [account, courses, items] = await Promise.all([
      accountInfo(env, 'classroom'),
      env.DB.prepare('SELECT * FROM classroom_courses ORDER BY name').all(),
      env.DB.prepare(`SELECT i.*, c.name AS course_name FROM classroom_items i LEFT JOIN classroom_courses c ON c.id = i.course_id
        ORDER BY CASE i.status WHEN 'new' THEN 0 WHEN 'approved' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END, i.updated DESC LIMIT 200`).all(),
    ]);
    return json({ account, courses: courses.results, items: items.results });
  }

  if ((p = m('PUT', '/classroom/courses/:id'))) {
    const b = await readJson(request);
    const target = b.target ? String(b.target).split('/').map((s) => s.trim()).filter(Boolean).slice(0, 2).join('/') : null;
    if (target && !/^[A-Z]{2,4}\d{3,4}\/[^/]+$/.test(target)) throw new HttpError(400, 'target must look like CSE207/MI');
    const semester = b.semester && /^(Spring|Summer|Fall)-\d{2}$/.test(b.semester) ? b.semester : null;
    // mapped_at moves only when the target changes: posts from before the mapping
    // stay in the inbox for review instead of being bulk-published.
    await env.DB.prepare(`UPDATE classroom_courses SET semester = ?2, auto_publish = ?3,
        mapped_at = CASE WHEN ?1 IS NULL THEN NULL WHEN target IS ?1 THEN mapped_at ELSE ?5 END, target = ?1 WHERE id = ?4`)
      .bind(target, semester, b.autoPublish ? 1 : 0, p.id, nowIso()).run();
    await logActivity(env, admin.email, 'mapped Classroom course', `${p.id} → ${target || '(unmapped)'}`);
    return json({ ok: true });
  }

  if ((p = m('POST', '/classroom/items/:key'))) {
    const b = await readJson(request);
    const key = decodeURIComponent(p.key);
    if (!['approve', 'reject', 'reset'].includes(b.action)) throw new HttpError(400, 'bad action');
    const status = { approve: 'approved', reject: 'rejected', reset: 'new' }[b.action];
    const dest = b.dest ? String(b.dest).split('/').map((s) => s.trim()).filter(Boolean).join('/') : null;
    await env.DB.prepare('UPDATE classroom_items SET status = ?, dest = COALESCE(?, dest), decided_by = ?, updated = ? WHERE key = ?')
      .bind(status, dest, admin.email, nowIso(), key).run();
    await logActivity(env, admin.email, `${status} Classroom item`, dest || key);
    if (b.action === 'approve' && b.syncNow) ctx.waitUntil(dispatchSync(env, { trigger: 'classroom-approval' }).catch(() => {}));
    return json({ ok: true });
  }

  // --- settings -------------------------------------------------------------------
  if ((p = m('GET', '/settings'))) {
    const [storage, classroom, meta] = await Promise.all([accountInfo(env, 'storage'), accountInfo(env, 'classroom'), getMeta(env)]);
    return json({
      accounts: { storage, classroom }, meta,
      admins: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
      repo: env.GITHUB_REPO, driveRoot: env.DRIVE_ROOT_ID, publicUrl: env.PUBLIC_URL,
    });
  }

  if ((p = m('PUT', '/settings/meta'))) {
    const b = await readJson(request);
    const clean = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k).trim(), String(v).trim().slice(0, 120)]).filter(([k, v]) => k && v));
    const current = await getMeta(env);
    await saveMeta(env, { courses: clean(b.courses ?? current.courses), instructors: clean(b.instructors ?? current.instructors) });
    await logActivity(env, admin.email, 'updated course/instructor names');
    return json({ ok: true });
  }

  if ((p = m('POST', '/accounts/:account/disconnect'))) {
    if (!['storage', 'classroom'].includes(p.account)) throw new HttpError(400, 'unknown account');
    await env.DB.prepare('DELETE FROM accounts WHERE account = ?').bind(p.account).run();
    await logActivity(env, admin.email, `disconnected ${p.account} account`);
    return json({ ok: true });
  }

  throw new HttpError(404, 'not found');
}
