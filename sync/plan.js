// Three-way reconciliation between Drive, Git and the last synced state.
// Pure function: no I/O. See test/plan.test.js for the full case table.
//
// Identity: Drive files are tracked by Drive ID (so Drive moves become Git
// renames); Git files are tracked by path + blob sha.
// Policy:   Drive is the source of truth. On a true conflict (both sides
//           changed) Drive wins and the Git version stays in Git history.
//           Nothing is ever lost: Drive deletions go to Drive's trash, Git
//           deletions stay in history.
import { createHash } from 'node:crypto';

export const MAX_GIT_BYTES = 100 * 1024 * 1024; // GitHub hard limit (100 MiB)

/**
 * @param {Map<string, DriveEntry>} drive  path -> { id, md5, size, mtime, export }
 * @param {Map<string, GitEntry>}   git    path -> { sha, size, mode }
 * @param {Map<string, StateEntry>} state  path -> { id, md5, sha, size, mtime }
 * @param {{ isIgnored?: (p:string)=>boolean, maxGitBytes?: number }} opts
 */
export function plan(drive, git, state, { isIgnored = () => false, maxGitBytes = MAX_GIT_BYTES } = {}) {
  const out = {
    toGit: { add: [], update: [], move: [], remove: [] },
    toDrive: { upload: [], update: [], move: [], trash: [] },
    driveOnly: [], // present on Drive, deliberately not on GitHub
    conflicts: [],
    unchanged: 0,
    next: new Map(), // provisional next state; `sha`/`md5` filled in by the applier where pending
  };
  const done = new Set();
  const eligible = (p, d) => d.size <= maxGitBytes && !isIgnored(p);
  const driveOnlyReason = (p, d) => (isIgnored(p) ? 'ignored' : `too large for GitHub (${(d.size / 1048576).toFixed(1)} MiB)`);
  const version = (d) => (d.export ? d.mtime : d.md5); // exports have no md5
  const stateVersion = (s) => (s.export ? s.mtime : s.md5);
  // mtime is only tracked for Google-native exports (they have no md5); for
  // everything else it would churn the state file on metadata-only edits.
  const keep = (p, d, sha) => out.next.set(p, {
    id: d.id, md5: d.md5, sha, size: d.size, ...(d.export ? { mtime: d.mtime, export: true } : {}),
  });

  const stateById = new Map();
  for (const [p, s] of state) if (s.id) stateById.set(s.id, p);

  // --- 1. Drive-side moves/renames (same Drive ID, new path) -------------------
  for (const [p, d] of drive) {
    if (state.has(p)) continue;
    const from = stateById.get(d.id);
    if (!from || from === p || drive.has(from)) continue;
    const s = state.get(from);
    const g = git.get(from);
    done.add(p).add(from);
    if (!eligible(p, d)) {
      if (g) out.toGit.remove.push({ path: from, why: 'moved to a Drive-only location' });
      out.driveOnly.push({ path: p, reason: driveOnlyReason(p, d) });
      keep(p, d, null);
      continue;
    }
    const contentSame = version(d) === stateVersion(s);
    if (g && s.sha && g.sha === s.sha && contentSame) {
      out.toGit.move.push({ from, to: p, sha: g.sha, mode: g.mode });
      keep(p, d, g.sha);
    } else {
      if (g && s.sha && g.sha !== s.sha) {
        out.conflicts.push({ path: p, kind: 'moved-on-drive-edited-on-github', resolution: 'Drive wins; GitHub edit kept in history' });
      }
      if (g) out.toGit.remove.push({ path: from, why: `moved to ${p}` });
      out.toGit.add.push({ path: p, id: d.id, entry: d });
      keep(p, d, undefined);
    }
  }

  // --- 2. Git-side moves (path vanished from Git, same blob appeared elsewhere) --
  const gitNewBySha = new Map();
  for (const [p, g] of git) if (!state.has(p) && !drive.has(p) && !done.has(p)) gitNewBySha.set(g.sha, p);
  for (const [from, s] of state) {
    if (done.has(from) || git.has(from) || !s.sha) continue;
    const to = gitNewBySha.get(s.sha);
    const d = drive.get(from);
    if (!to || !d || d.id !== s.id || version(d) !== stateVersion(s) || d.export) continue;
    gitNewBySha.delete(s.sha);
    done.add(from).add(to);
    out.toDrive.move.push({ id: d.id, from, to });
    keep(to, d, s.sha);
  }

  // --- 2b. Untracked renames (no state on either side, e.g. at bootstrap) ------
  // A Git-only and a Drive-only file in the same folder with the same size and
  // extension are probably one file renamed on Drive. The applier verifies by
  // hashing the Drive bytes; on mismatch it falls back to uploading the Git file.
  const dir = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  const extOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');
  const gitOrphans = [...git].filter(([p]) => !state.has(p) && !drive.has(p) && !done.has(p));
  const pathsBySha = new Map();
  for (const [p, g] of git) pathsBySha.set(g.sha, [...(pathsBySha.get(g.sha) || []), p]);
  for (const [gp, g] of gitOrphans) {
    // Same bytes already exist on GitHub under a path Drive has: a stray duplicate.
    const twin = pathsBySha.get(g.sha).find((o) => o !== gp && drive.has(o));
    if (twin) {
      done.add(gp);
      out.toGit.remove.push({ path: gp, why: `duplicate of ${twin}` });
      continue;
    }
    const match = [...drive].find(([dp, d]) => !state.has(dp) && !git.has(dp) && !done.has(dp) &&
      !stateById.has(d.id) && dir(dp) === dir(gp) && extOf(dp) === extOf(gp) && d.size === g.size && eligible(dp, d));
    if (!match) continue;
    const [dp, d] = match;
    done.add(dp).add(gp);
    out.toGit.add.push({ path: dp, id: d.id, entry: d, replaces: { path: gp, sha: g.sha, size: g.size } });
    keep(dp, d, undefined);
  }

  // --- 3. Everything else, path by path --------------------------------------
  const paths = new Set([...drive.keys(), ...git.keys(), ...state.keys()]);
  for (const p of paths) {
    if (done.has(p)) continue;
    const d = drive.get(p);
    const g = git.get(p);
    const s = state.get(p);

    if (d && !eligible(p, d)) {
      // Drive-only file. If a copy is on GitHub (newly ignored / grew), take it down.
      if (g) out.toGit.remove.push({ path: p, why: driveOnlyReason(p, d) });
      out.driveOnly.push({ path: p, reason: driveOnlyReason(p, d) });
      keep(p, d, null);
      continue;
    }

    if (d && g && s) {
      const dChanged = version(d) !== stateVersion(s) || d.id !== s.id;
      const gChanged = g.sha !== s.sha;
      if (!dChanged && !gChanged) { out.unchanged++; keep(p, d, g.sha); continue; }
      if (dChanged && gChanged) {
        out.conflicts.push({ path: p, kind: 'edited-on-both', resolution: 'Drive wins; GitHub edit kept in history' });
        out.toGit.update.push({ path: p, id: d.id, entry: d, mode: g.mode });
        keep(p, d, undefined);
      } else if (dChanged) {
        out.toGit.update.push({ path: p, id: d.id, entry: d, mode: g.mode });
        keep(p, d, undefined);
      } else if (d.export) {
        out.conflicts.push({ path: p, kind: 'edited-export-on-github', resolution: 'Google file is the source; GitHub copy restored' });
        out.toGit.update.push({ path: p, id: d.id, entry: d, mode: g.mode });
        keep(p, d, undefined);
      } else {
        out.toDrive.update.push({ path: p, id: d.id, sha: g.sha });
        out.next.set(p, { id: d.id, md5: undefined, sha: g.sha, size: g.size, mtime: undefined });
      }
      continue;
    }

    if (d && g && !s) {
      // Both have it, never reconciled (bootstrap): verify by content, Drive wins.
      out.toGit.update.push({ path: p, id: d.id, entry: d, mode: g.mode, expectSha: g.sha });
      keep(p, d, undefined);
      continue;
    }

    if (d && !g && s) {
      if (s.sha === null) {
        // Was Drive-only and now fits (limit raised / unignored).
        out.toGit.add.push({ path: p, id: d.id, entry: d });
        keep(p, d, undefined);
      } else if (version(d) === stateVersion(s) && !d.export) {
        out.toDrive.trash.push({ path: p, id: d.id, why: 'deleted on GitHub' });
      } else {
        out.conflicts.push({ path: p, kind: 'deleted-on-github-edited-on-drive', resolution: 'kept; restored to GitHub' });
        out.toGit.add.push({ path: p, id: d.id, entry: d });
        keep(p, d, undefined);
      }
      continue;
    }

    if (d && !g && !s) {
      out.toGit.add.push({ path: p, id: d.id, entry: d });
      keep(p, d, undefined);
      continue;
    }

    if (!d && g && s) {
      if (g.sha === s.sha) out.toGit.remove.push({ path: p, why: 'deleted on Drive' });
      else {
        out.conflicts.push({ path: p, kind: 'deleted-on-drive-edited-on-github', resolution: 'kept; restored to Drive' });
        out.toDrive.upload.push({ path: p, sha: g.sha });
        out.next.set(p, { id: undefined, md5: undefined, sha: g.sha, size: g.size });
      }
      continue;
    }

    if (!d && g && !s) {
      out.toDrive.upload.push({ path: p, sha: g.sha });
      out.next.set(p, { id: undefined, md5: undefined, sha: g.sha, size: g.size });
      continue;
    }
    // !d && !g && s: gone from both. Drop from state.
  }

  for (const k of Object.keys(out.toGit)) out.toGit[k].sort((a, b) => (a.path || a.to).localeCompare(b.path || b.to));
  for (const k of Object.keys(out.toDrive)) out.toDrive[k].sort((a, b) => (a.path || a.to).localeCompare(b.path || b.to));
  return out;
}

/** Deletions that would take effect on either side. */
export function deletions(p) {
  return [
    ...p.toGit.remove.filter((r) => /deleted on Drive/.test(r.why)).map((r) => `git:${r.path}`),
    ...p.toDrive.trash.map((t) => `drive:${t.path}`),
  ].sort();
}

/** Stable hash of the destructive part of a plan, used for approvals. */
export function planHash(p) {
  return createHash('sha256').update(deletions(p).join('\n')).digest('hex').slice(0, 16);
}

export function summary(p) {
  return {
    gitAdd: p.toGit.add.length,
    gitUpdate: p.toGit.update.filter((u) => !u.expectSha).length,
    verify: p.toGit.update.filter((u) => u.expectSha).length,
    gitMove: p.toGit.move.length, gitRemove: p.toGit.remove.length,
    driveUpload: p.toDrive.upload.length, driveUpdate: p.toDrive.update.length,
    driveMove: p.toDrive.move.length, driveTrash: p.toDrive.trash.length,
    driveOnly: p.driveOnly.length, conflicts: p.conflicts.length, unchanged: p.unchanged,
  };
}
