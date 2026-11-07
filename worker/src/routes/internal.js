// Endpoints for the sync job (GitHub Actions). Authenticated by SYNC_TOKEN.
import { HttpError, json, readJson, safeEqual, nowIso } from '../util.js';
import { accessToken, accountInfo } from '../google.js';
import { saveCatalog } from '../catalog.js';
import { logActivity } from '../activity.js';

export async function handleInternal(request, env, url) {
  const auth = request.headers.get('authorization') || '';
  if (!env.SYNC_TOKEN || !safeEqual(auth, `Bearer ${env.SYNC_TOKEN}`)) throw new HttpError(401, 'bad sync token');
  const route = `${request.method} ${url.pathname.slice('/api/internal'.length)}`;

  if (route === 'POST /token') {
    const { account } = await readJson(request);
    if (!['storage', 'classroom'].includes(account)) throw new HttpError(400, 'unknown account');
    const t = await accessToken(env, account);
    return json({ access_token: t.token, expires_at: t.expiresAt });
  }

  if (route === 'POST /runs') {
    const r = await readJson(request);
    const id = r.runId ? String(r.runId) : crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO runs (id, status, trigger, started, finished, counts, plan_hash, commit_sha, run_url, report)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(id) DO UPDATE SET status=?2, finished=?5, counts=?6, plan_hash=?7, commit_sha=?8, report=?10`,
    ).bind(id, r.status, r.trigger || null, r.started || nowIso(), r.finished || null, JSON.stringify(r.counts || {}),
      r.planHash || null, r.commit || null, r.runUrl || null, JSON.stringify(r).slice(0, 900_000)).run();
    return json({ ok: true, id });
  }

  if (route === 'PUT /catalog') {
    const doc = await readJson(request);
    if (!Array.isArray(doc.files)) throw new HttpError(400, 'files[] required');
    await saveCatalog(env, doc);
    return json({ ok: true, files: doc.files.length });
  }

  if (route === 'GET /classroom') {
    const [cls, storage] = await Promise.all([accountInfo(env, 'classroom'), accountInfo(env, 'storage')]);
    const { results } = await env.DB.prepare('SELECT id, target, semester, auto_publish, cursor FROM classroom_courses WHERE target IS NOT NULL').all();
    return json({
      connected: Boolean(cls && !cls.last_error),
      sameAccount: Boolean(cls && storage && cls.email === storage.email),
      courses: results.map((c) => ({ id: c.id, target: c.target, semester: c.semester, autoPublish: !!c.auto_publish, cursor: c.cursor })),
    });
  }

  if (route === 'POST /classroom/items') {
    const { discovered = [], items = [], cursors = {} } = await readJson(request);
    const now = nowIso();
    const stmts = [];
    for (const c of discovered) {
      stmts.push(env.DB.prepare(
        `INSERT INTO classroom_courses (id, name, section, link, seen_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name=?2, section=?3, link=?4, seen_at=?5`,
      ).bind(c.id, c.name, c.section, c.link, now));
    }
    for (const it of items) {
      // New attachments land as "new"; ones already decided keep their status.
      stmts.push(env.DB.prepare(
        `INSERT INTO classroom_items (key, course_id, file_id, title, link, post_kind, post_title, post_link, topic, dest, status, created, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11, ?12)
         ON CONFLICT(key) DO UPDATE SET title=?4, post_title=?7, topic=?9, updated=?12,
           dest = CASE WHEN classroom_items.status = 'new' THEN ?10 ELSE classroom_items.dest END`,
      ).bind(it.key, it.courseId, it.fileId, it.title, it.link, it.postKind, it.postTitle, it.postLink, it.topic, it.dest, it.created, it.updated));
    }
    for (const [id, cursor] of Object.entries(cursors)) {
      stmts.push(env.DB.prepare('UPDATE classroom_courses SET cursor = ? WHERE id = ?').bind(cursor, id));
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));

    // Import now: approved items, plus new items from auto-publish courses.
    const { results } = await env.DB.prepare(
      `SELECT i.key, i.file_id AS fileId, i.title, i.dest FROM classroom_items i
       JOIN classroom_courses c ON c.id = i.course_id
       WHERE i.status = 'approved'
          OR (i.status = 'new' AND c.auto_publish = 1 AND c.target IS NOT NULL AND i.created >= c.mapped_at)
       LIMIT 200`,
    ).all();
    return json({ import: results });
  }

  if (route === 'POST /classroom/results') {
    const { results = [] } = await readJson(request);
    for (const r of results) {
      await env.DB.prepare('UPDATE classroom_items SET status = ?, drive_id = ?, path = ?, error = ?, updated = ? WHERE key = ?')
        .bind(r.status, r.driveId || null, r.path || null, r.error || null, nowIso(), r.key).run();
      if (r.status === 'imported') await logActivity(env, 'classroom', 'imported', r.path);
    }
    return json({ ok: true });
  }

  throw new HttpError(404, 'not found');
}
