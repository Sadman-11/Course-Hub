// GitHub: dispatch the sync workflow, read its runs, fetch file bytes.
// Uses a fine-grained PAT scoped to the content repo: Actions read/write,
// Contents read-only. The Worker can trigger syncs but cannot write content.
import { HttpError } from './util.js';

const API = 'https://api.github.com';
const headers = (env) => ({
  authorization: `Bearer ${env.GITHUB_TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'course-hub-worker',
});

export async function dispatchSync(env, { dryRun = false, approve = '', trigger = 'dashboard' } = {}) {
  if (!/^(github_pat_|gh[pousr]_)/.test(env.GITHUB_TOKEN || '')) throw new HttpError(409, 'GITHUB_TOKEN is not set yet (wrangler secret put GITHUB_TOKEN)');
  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { ...headers(env), 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { dry_run: dryRun, approve, trigger } }),
  });
  if (res.status !== 204) throw new HttpError(502, `GitHub dispatch failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return tokenExpiry(res);
}

export async function workflowRuns(env, perPage = 10) {
  if (!/^(github_pat_|gh[pousr]_)/.test(env.GITHUB_TOKEN || '')) throw new HttpError(409, 'GITHUB_TOKEN is not set yet (wrangler secret put GITHUB_TOKEN)');
  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/runs?per_page=${perPage}`, { headers: headers(env) });
  if (!res.ok) throw new HttpError(502, `GitHub runs: ${res.status}`);
  const j = await res.json();
  return {
    tokenExpires: tokenExpiry(res),
    runs: j.workflow_runs.map((r) => ({
      id: String(r.id), status: r.status, conclusion: r.conclusion, event: r.event,
      created: r.created_at, updated: r.updated_at, url: r.html_url,
    })),
  };
}

/** Raw bytes of a file at an exact commit (immutable, so safe to cache forever). */
export function rawFile(env, commit, path) {
  const url = `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  // Authenticated for the higher rate limit; anonymous works too (public repo, local dev).
  const auth = /^(github_pat_|gh[pousr]_)/.test(env.GITHUB_TOKEN || '') ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
  return fetch(url, { headers: { ...auth, 'user-agent': 'course-hub-worker' } });
}

// Fine-grained PATs expire (max 1 year). GitHub reports the date on every response.
function tokenExpiry(res) {
  const h = res.headers.get('github-authentication-token-expiration');
  return h ? new Date(h.replace(' UTC', 'Z').replace(' ', 'T').replace(/ \+0000$/, 'Z')).toISOString() : null;
}
