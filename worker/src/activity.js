import { nowIso } from './util.js';

export async function logActivity(env, actor, action, detail = null) {
  await env.DB.prepare('INSERT INTO activity (at, actor, action, detail) VALUES (?, ?, ?, ?)')
    .bind(nowIso(), actor, action, detail === null ? null : String(detail).slice(0, 500)).run();
}

export async function recentActivity(env, limit = 30) {
  const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM activity ORDER BY at DESC, id DESC LIMIT ?').bind(limit).all();
  return results;
}
