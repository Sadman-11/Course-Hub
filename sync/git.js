// Git plumbing over a blobless, no-checkout clone. No working tree is ever
// materialised: blobs are written straight into the object store and staged
// with update-index, so a 1.4 GB repo costs a few MB per run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export class Git {
  constructor(dir, env = {}) {
    this.dir = dir;
    this.env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env };
  }

  // noFetch: forbid lazy blob fetches. Used for every step that must work from
  // trees alone, so a mistake fails loudly instead of downloading the whole repo.
  run(args, { input, binary = false, noFetch = false } = {}) {
    return new Promise((resolve, reject) => {
      const env = noFetch ? { ...this.env, GIT_NO_LAZY_FETCH: '1' } : this.env;
      const p = spawn('git', args, { cwd: this.dir, env });
      const out = [];
      const err = [];
      p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => err.push(d));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`git ${args.join(' ')} → ${code}: ${Buffer.concat(err).toString().trim()}`));
        const buf = Buffer.concat(out);
        resolve(binary ? buf : buf.toString('utf8'));
      });
      if (input !== undefined) p.stdin.end(input);
      else p.stdin.end();
    });
  }

  static async clone(url, dir, { branch = 'main', full = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const g = new Git(dir);
    const args = ['clone', '--no-checkout', '--depth=1', `--branch=${branch}`, '--single-branch'];
    if (!full) args.push('--filter=blob:none');
    await g.run([...args, url, '.']);
    await g.run(['read-tree', 'HEAD'], { noFetch: true });
    return g;
  }

  head() {
    return this.run(['rev-parse', 'HEAD']).then((s) => s.trim());
  }

  /**
   * Map<path, {sha, size, mode}> of every blob at HEAD.
   * `ls-tree -l` would lazily fetch every blob just to report its size, so
   * sizes come from `sizeOf` (the GitHub trees API) when given. Without it
   * (local/test repos) we fall back to `ls-tree -l`, which may fetch.
   */
  async tree(ref = 'HEAD', { sizeOf } = {}) {
    const long = !sizeOf;
    const out = await this.run(['ls-tree', '-r', ...(long ? ['-l'] : []), '-z', '--full-tree', ref], { noFetch: !long });
    const map = new Map();
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const [mode, type, sha, size] = rec.slice(0, tab).split(/\s+/);
      if (type !== 'blob') continue;
      const p = rec.slice(tab + 1);
      map.set(p, { sha, size: long ? Number(size) : sizeOf(p, sha) ?? -1, mode });
    }
    return map;
  }

  /** Write bytes as a blob exactly as-is (no CRLF/filters). */
  async hashFile(file) {
    return (await this.run(['hash-object', '-w', '--no-filters', '--', file])).trim();
  }

  async hashBuffer(buf) {
    return (await this.run(['hash-object', '-w', '--no-filters', '--stdin'], { input: buf })).trim();
  }

  /** Blob content (lazily fetched from the promisor remote in a partial clone). */
  catBlob(sha) {
    return this.run(['cat-file', 'blob', sha], { binary: true });
  }

  /** Prefetch many blobs in one round trip instead of one fetch per blob. */
  async prefetch(shas) {
    if (!shas.length) return;
    try {
      await this.run(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head',
        '--filter=blob:none', 'origin', ...shas]);
    } catch {
      /* not fatal: cat-file will fetch lazily */
    }
  }

  /**
   * Stage changes. entries: [{ path, sha, mode }] to add/replace, [{ path, remove: true }] to delete.
   */
  async stage(entries) {
    if (!entries.length) return;
    const zero = '0'.repeat(40);
    const lines = entries.map((e) => (e.remove ? `0 ${zero}\t${e.path}` : `${e.mode || '100644'} ${e.sha}\t${e.path}`));
    await this.run(['update-index', '-z', '--index-info'], { input: lines.join('\0') + '\0', noFetch: true });
  }

  /** Commit the index on top of HEAD. Returns the new commit sha, or null if nothing changed. */
  async commit(message, author) {
    const tree = (await this.run(['write-tree', '--missing-ok'], { noFetch: true })).trim();
    const headTree = (await this.run(['rev-parse', 'HEAD^{tree}'], { noFetch: true })).trim();
    if (tree === headTree) return null;
    const env = {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
    };
    const g = new Git(this.dir, env);
    const sha = (await g.run(['commit-tree', tree, '-p', 'HEAD', '-F', '-'], { input: message, noFetch: true })).trim();
    await this.run(['update-ref', 'HEAD', sha], { noFetch: true });
    return sha;
  }

  // Pushing from a blobless clone without downloading blobs:
  //  --no-thin            don't delta new blobs against server-side versions we don't hold
  //  pack.useSparse=false the default "sparse" walk only compares trees at the same
  //                       path, so a file moved to another folder looks new and git
  //                       tries to pack (= read) its blob. The full walk marks every
  //                       object the server already has as known, using trees alone.
  // If git still needs a missing object, retry once allowing the fetch: slower, still correct.
  async push(branch = 'main') {
    const args = ['-c', 'pack.useSparse=false', 'push', '--no-thin', 'origin', `HEAD:refs/heads/${branch}`];
    try {
      return await this.run(args, { noFetch: true });
    } catch (e) {
      if (!/promisor remote|lazy fetching disabled/.test(e.message)) throw e;
      console.warn('push needed objects not in the blobless clone; retrying with on-demand fetch');
      return this.run(args);
    }
  }
}

/** Blob sizes for a commit via the GitHub trees API (one request, no blob downloads). */
export async function githubSizes(repo, token, commitSha) {
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${commitSha}?recursive=1`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'course-sync' },
  });
  if (!res.ok) throw new Error(`GitHub trees API → ${res.status}`);
  const j = await res.json();
  if (j.truncated) throw new Error('GitHub trees API response truncated');
  const bySha = new Map(j.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.size]));
  return (p) => bySha.get(p);
}
