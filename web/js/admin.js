import { html, mount, $, $$, bytes, ago, day, plural, icon, toast, initTheme, encodePath } from './lib.js';
import { CATEGORIES, categoryFromName, cleanName, semesterFromDate, semesterKey } from './taxonomy.js';

const main = $('#main');
const STATUS_TEXT = {
  ok: 'synced', partial: 'partial', failed: 'failed', dry_run: 'dry run', needs_approval: 'needs approval',
  new: 'new', approved: 'approved', imported: 'imported', rejected: 'rejected',
};
const status = (s) => html`<span class="status" data-s="${s}">${STATUS_TEXT[s] || s || '—'}</span>`;

// --- API ----------------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: { 'x-requested-with': 'course-hub', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/auth/login?next=/admin'; throw new Error('signed out'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
let catalog = null;
const loadCatalog = async () => (catalog ??= await fetch('/api/catalog').then((r) => r.json()));

function fail(e) {
  console.error(e);
  toast(e.message || 'Something went wrong');
}

// --- views ----------------------------------------------------------------------
async function viewOverview() {
  const o = await api('/overview');
  const lib = o.library;
  const last = o.runs.find((r) => ['ok', 'partial', 'failed', 'needs_approval'].includes(r.status));
  const alerts = [];
  if (!o.accounts.storage) alerts.push(['bad', 'Google Drive isn’t connected. Nothing can sync until it is.', html`<a class="btn sm" href="/auth/connect?account=storage">Connect Drive</a>`]);
  else if (o.accounts.storage.last_error) alerts.push(['bad', `Drive: ${o.accounts.storage.last_error}`, html`<a class="btn sm" href="/auth/connect?account=storage">Reconnect</a>`]);
  if (o.accounts.classroom?.last_error) alerts.push(['bad', `Classroom: ${o.accounts.classroom.last_error}`, html`<a class="btn sm" href="/auth/connect?account=classroom">Reconnect</a>`]);
  const blocked = o.runs.find((r) => r.status === 'needs_approval');
  if (blocked && blocked === o.runs[0]) alerts.push(['bad', `The last run stopped before deleting ${blocked.counts.gitRemove + blocked.counts.driveTrash} files. Review it before anything is removed.`, html`<a class="btn sm" href="#/sync/${blocked.id}">Review</a>`]);
  if (o.github.error) alerts.push(['warn', `GitHub: ${o.github.error}`, '']);
  if (o.github.tokenExpires) {
    const days = Math.round((new Date(o.github.tokenExpires) - Date.now()) / 864e5);
    if (days < 30) alerts.push([days < 7 ? 'bad' : 'warn', `The GitHub token expires in ${days} days (${day(o.github.tokenExpires)}). Make a new one and run “wrangler secret put GITHUB_TOKEN”.`, '']);
  }
  if (o.inbox) alerts.push(['warn', `${plural(o.inbox, 'Classroom file')} waiting for review.`, html`<a class="btn sm" href="#/classroom">Open inbox</a>`]);

  const healthy = last && last.status === 'ok' && !alerts.some((a) => a[0] === 'bad');
  const c = last?.counts || {};
  const changed = (c.gitAdd || 0) + (c.gitUpdate || 0) + (c.gitMove || 0) + (c.gitRemove || 0) + (c.driveUpload || 0) + (c.driveUpdate || 0);
  const repoPct = Math.min(100, (lib.githubBytes / (5 * 1024 ** 3)) * 100);

  mount(main, html`
    <div class="page-title"><h1>Overview</h1>
      <div class="tools"><button class="btn" data-act="sync" data-dry="1">${icon('refresh')}Dry run</button><button class="btn primary" data-act="sync">${icon('refresh')}Sync now</button></div></div>
    <p class="headline"><span class="dot ${healthy ? '' : last ? 'warn' : 'bad'}"></span>${
      last ? html`${healthy ? 'Everything is in sync.' : 'Needs attention.'} Last run ${ago(last.finished || last.started)}${changed ? `, ${plural(changed, 'change')}` : ', no changes'}.`
        : 'No sync has run yet.'}</p>
    ${alerts.length ? html`<ul class="alerts">${alerts.map(([k, msg, act]) => html`<li class="alert ${k}"><span>${msg}</span>${act}</li>`)}</ul>` : ''}
    <div class="metrics">
      <div class="metric"><b>${lib.files.toLocaleString()}</b><span>files on Drive</span></div>
      <div class="metric"><b>${lib.onGithub.toLocaleString()}</b><span>mirrored on GitHub</span></div>
      <div class="metric"><b>${lib.driveOnly}</b><span>Drive-only (over 100 MiB / ignored)</span></div>
      <div class="metric"><b>${lib.courses}</b><span>courses</span></div>
      <div class="metric"><b>${bytes(lib.bytes)}</b><span>library size</span></div>
      <div class="metric"><b>${bytes(lib.githubBytes)}</b><span>on GitHub, of the 5 GB soft limit</span><div class="meter"><i class="${repoPct > 60 ? 'warn' : ''}" data-w="${repoPct.toFixed(1)}"></i></div></div>
    </div>
    <div class="grid-2">
      <section class="block"><h2 class="h">Recent runs <a class="meta" href="#/sync">all runs →</a></h2>${runsTable(o.runs.slice(0, 6), true)}</section>
      <section class="block"><h2 class="h">Activity</h2>
        ${o.activity.length ? html`<ul class="feed">${o.activity.map((a) => html`<li><time title="${a.at}">${ago(a.at)}</time><div>${a.actor ? html`<b>${a.actor.split('@')[0]}</b> ` : ''}${a.action}${a.detail ? html`<span class="d">${a.detail}</span>` : ''}</div></li>`)}</ul>`
          : html`<p class="empty-s">Nothing yet.</p>`}
      </section>
    </div>`);
  // CSP forbids inline styles; set widths through the CSSOM instead.
  $$('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
}

function runsTable(runs, compact = false) {
  if (!runs.length) return html`<p class="empty-s">No runs yet. Press “Sync now” to start the first one.</p>`;
  const delta = (c) => [c.gitAdd && `+${c.gitAdd}`, c.gitUpdate && `~${c.gitUpdate}`, c.gitMove && `→${c.gitMove}`, c.gitRemove && `−${c.gitRemove}`,
    (c.driveUpload || c.driveUpdate) && `⇢Drive ${(c.driveUpload || 0) + (c.driveUpdate || 0)}`].filter(Boolean).join('  ') || 'no changes';
  return html`<div class="table-scroll"><table class="t"><thead><tr><th>Status</th><th>When</th>${compact ? '' : html`<th>Trigger</th>`}<th>Changes</th><th></th></tr></thead><tbody>
    ${runs.map((r) => html`<tr class="clickable" data-href="#/sync/${r.id}"><td>${status(r.status)}</td><td class="mono" title="${r.started}">${ago(r.finished || r.started)}</td>
      ${compact ? '' : html`<td class="mono muted">${(r.trigger || '').replace('dashboard:', '')}</td>`}<td class="mono">${delta(r.counts || {})}</td>
      <td class="num">${r.run_url ? html`<a class="icon-btn" href="${r.run_url}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open run on GitHub">${icon('external')}</a>` : ''}</td></tr>`)}
  </tbody></table></div>`;
}

async function viewSync(runId) {
  const runs = await api('/runs');
  let detail = '';
  if (runId) {
    const r = await api(`/runs/${runId}`);
    const d = r.details || {};
    const list = (title, items, fmt = (x) => x) => (items?.length ? html`<section><h4>${title} (${items.length})</h4><ul>${items.slice(0, 200).map((x) => html`<li>${fmt(x)}</li>`)}</ul></section>` : '');
    const pair = (x) => html`${x[0]} <span class="why">→ ${x[1]}</span>`;
    detail = html`<div class="panel">
      <h3>${status(r.status)} Run ${r.runId || runId} <span class="muted mono">· ${r.trigger || ''} · ${r.started ? new Date(r.started).toLocaleString() : ''}</span></h3>
      ${r.status === 'needs_approval' ? html`<div class="alert bad"><span>This run would delete ${plural(r.deletions.length, 'file')}. Check the list below. If it’s intended, approve exactly this plan (hash <code>${r.planHash}</code>).</span>
        <button class="btn sm danger" data-act="approve" data-hash="${r.planHash}">Approve these deletions</button></div><br>` : ''}
      ${r.errors?.length ? html`<div class="alert bad"><span>${plural(r.errors.length, 'error')}: ${r.errors.slice(0, 3).map((e) => `${e.path || e.where}: ${e.error}`).join(' · ')}</span></div><br>` : ''}
      <div class="changes">
        ${list('Deletions awaiting approval', r.status === 'needs_approval' ? r.deletions : [])}
        ${list('Added to GitHub', d.gitAdd)}${list('Updated on GitHub', d.gitUpdate)}${list('Moved on GitHub', d.gitMove, pair)}
        ${list('Removed from GitHub', d.gitRemove, pair)}${list('Copied to Drive', d.driveUpload)}${list('Updated on Drive', d.driveUpdate)}
        ${list('Moved on Drive', d.driveMove, pair)}${list('Trashed on Drive', d.driveTrash, pair)}${list('Drive-only', d.driveOnly, pair)}
        ${list('Conflicts (Drive kept)', r.conflicts, (c) => html`${c.path} <span class="why">${c.kind}</span>`)}
        ${list('Classroom imports', r.classroom?.imported)}
        ${list('Warnings', r.issues, (i) => html`${i.path} <span class="why">${i.type}</span>`)}
      </div>
      ${r.verified ? html`<p class="note">${plural(r.verified, 'file')} verified identical by content.</p>` : ''}
    </div>`;
  }
  mount(main, html`
    <div class="page-title"><h1>Sync</h1>
      <div class="tools"><button class="btn" data-act="sync" data-dry="1">${icon('refresh')}Dry run</button><button class="btn primary" data-act="sync">${icon('refresh')}Sync now</button></div></div>
    <p class="note">Drive is the master copy. Every 30 minutes, and whenever someone pushes to GitHub, the job copies changes both ways. Moves keep their history, Drive deletions go to Drive’s trash, and any run that would delete a lot stops here for approval.</p>
    ${detail}
    <section class="block">${runsTable(runs)}</section>`);
}

// --- Files ------------------------------------------------------------------------
async function viewFiles(path = '') {
  const [{ items }, cat] = await Promise.all([api(`/drive?path=${encodeURIComponent(path)}`), loadCatalog()]);
  const parts = path ? path.split('/') : [];
  const courses = [...new Set(cat.files.map((r) => r[0].split('/')[0]))].sort();
  const sems = semesterOptions();
  const here = { course: parts[0] || '', instructor: parts[1] || '', category: CATEGORIES.includes(parts[2]) ? parts[2] : '', semester: parts[3] || '' };
  mount(main, html`
    <div class="page-title"><h1>Files</h1><div class="tools">
      <button class="btn" data-act="mkdir">${icon('plus')}New folder</button>
      <button class="btn primary" data-act="toggle-upload">${icon('upload')}Add files</button></div></div>

    <div class="panel" id="upload" hidden>
      <h3>Add files to the library</h3>
      <p class="note">Pick where they belong. Files land at <code>COURSE / INSTRUCTOR / Category / Semester</code> on Drive, and the next sync publishes them.</p>
      <div class="row-form">
        <label class="field"><span>Course</span><input class="input mono" id="u-course" list="dl-courses" value="${here.course}" placeholder="CSE207" required></label>
        <label class="field"><span>Instructor</span><input class="input mono" id="u-inst" list="dl-inst" value="${here.instructor}" placeholder="initials, e.g. MI"></label>
        <label class="field"><span>Category</span><select class="input" id="u-cat"><option value="">Guess from file name</option>${CATEGORIES.map((c) => html`<option ${c === here.category ? 'selected' : ''}>${c}</option>`)}</select></label>
        <label class="field"><span>Semester</span><select class="input" id="u-sem"><option value="none">No semester</option>${sems.map((s) => html`<option ${s === (here.semester || semesterFromDate(Date.now())) ? 'selected' : ''}>${s}</option>`)}</select></label>
      </div>
      <datalist id="dl-courses">${courses.map((c) => html`<option value="${c}">`)}</datalist>
      <datalist id="dl-inst"></datalist>
      <br>
      <div class="drop" id="drop" tabindex="0" role="button">Drop files here, or click to choose <input type="file" id="u-files" multiple hidden></div>
      <ul class="queue" id="queue"></ul>
    </div>

    <div class="browser-bar">
      <nav class="path" aria-label="Folder"><a href="#/files">Library</a>${parts.map((p, i) => html`<i>/</i><a href="#/files/${encodePath(parts.slice(0, i + 1).join('/'))}">${p}</a>`)}</nav>
      <span class="note">${plural(items.length, 'item')} · live from Drive</span>
    </div>
    ${items.length ? html`<div class="table-scroll"><table class="t"><thead><tr><th>Name</th><th class="num">Size</th><th>Modified</th><th></th></tr></thead><tbody>
      ${items.map((f) => {
        const full = path ? `${path}/${f.name}` : f.name;
        return html`<tr data-id="${f.id}" data-name="${f.name}">
          <td class="wrap"><div class="name-cell">${icon(f.folder ? 'folder' : 'file')}${f.folder ? html`<a href="#/files/${encodePath(full)}">${f.name}</a>` : html`<a href="/f/${encodePath(full)}" target="_blank" rel="noopener">${f.name}</a>`}</div></td>
          <td class="num">${f.folder ? '' : bytes(f.size)}</td><td class="mono muted">${day(f.modified)}</td>
          <td><div class="row-acts">
            <button class="icon-btn" data-act="rename" title="Rename" aria-label="Rename ${f.name}">${icon('edit')}</button>
            <button class="icon-btn" data-act="move" title="Move" aria-label="Move ${f.name}">${icon('folder')}</button>
            <button class="icon-btn" data-act="trash" title="Move to Drive trash" aria-label="Trash ${f.name}">${icon('trash')}</button>
          </div></td></tr>`;
      })}</tbody></table></div>` : html`<p class="empty-s">This folder is empty.</p>`}`);

  // Upload panel wiring
  const instFor = () => {
    const c = $('#u-course').value.trim().toUpperCase();
    const set = [...new Set(cat.files.filter((r) => r[0].startsWith(`${c}/`)).map((r) => r[0].split('/')[1]))].sort();
    mount($('#dl-inst'), html`${set.map((i) => html`<option value="${i}">${cat.meta?.instructors?.[i] || ''}</option>`)}`);
  };
  $('#u-course').addEventListener('input', instFor);
  instFor();
  const input = $('#u-files');
  const drop = $('#drop');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { upload([...input.files]); input.value = ''; });
  if (location.hash.includes('upload=1')) $('#upload').hidden = false;
}

function semesterOptions() {
  const now = semesterFromDate(Date.now());
  const out = [];
  let [season, yy] = now.split('-');
  const seasons = ['Spring', 'Summer', 'Fall'];
  let i = seasons.indexOf(season);
  let y = Number(yy);
  // next term, current, then the previous eight
  i += 1; if (i > 2) { i = 0; y += 1; }
  for (let k = 0; k < 10; k++) {
    out.push(`${seasons[i]}-${String(y).padStart(2, '0')}`);
    i -= 1; if (i < 0) { i = 2; y -= 1; }
  }
  return out.sort((a, b) => semesterKey(b) - semesterKey(a));
}

function destination(file) {
  const course = $('#u-course').value.trim().toUpperCase().replace(/\s+/g, '');
  const inst = $('#u-inst').value.trim() || 'General';
  const cat = $('#u-cat').value || categoryFromName(file.name, file.size);
  const sem = $('#u-sem').value === 'none' ? null : $('#u-sem').value;
  return { dir: [course, inst, cat, sem].filter(Boolean).join('/'), name: cleanName(file.name) };
}

function upload(files) {
  if (!/^[A-Z]{2,4}\d{3,4}$/.test($('#u-course').value.trim().toUpperCase().replace(/\s+/g, ''))) { toast('Enter a course code like CSE207 first'); $('#u-course').focus(); return; }
  const queue = $('#queue');
  let pending = files.length;
  for (const file of files) {
    const { dir, name } = destination(file);
    const li = document.createElement('li');
    mount(li, html`<div><b>${file.name}</b><span class="to">→ ${dir}/${name} · ${bytes(file.size)}</span></div><progress max="100" value="0"></progress>`);
    queue.append(li);
    if (file.size > 100 * 1024 * 1024) {
      mount(li, html`<div><b>${file.name}</b><span class="to">Over 100 MB: upload this one in Google Drive directly, into ${dir}</span></div><span class="err">too big</span>`);
      if (--pending === 0) afterUploads();
      continue;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/drive/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('x-requested-with', 'course-hub');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) li.querySelector('progress').value = (e.loaded / e.total) * 100; };
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      let msg = 'failed';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* not json */ }
      li.replaceChild(Object.assign(document.createElement('span'), { className: ok ? 'done' : 'err', textContent: ok ? 'uploaded' : msg }), li.querySelector('progress'));
      if (--pending === 0) afterUploads();
    };
    xhr.onerror = () => { li.querySelector('progress').replaceWith(Object.assign(document.createElement('span'), { className: 'err', textContent: 'network error' })); if (--pending === 0) afterUploads(); };
    xhr.send(file);
  }
}

function afterUploads() {
  const li = document.createElement('li');
  mount(li, html`<span class="note">Uploads finished. They’ll appear on GitHub and the site after the next sync.</span><button class="btn sm primary" data-act="sync">Sync now</button>`);
  $('#queue').append(li);
}

// --- Classroom ------------------------------------------------------------------------
async function viewClassroom() {
  const [d, cat] = await Promise.all([api('/classroom'), loadCatalog()]);
  const targets = [...new Set(cat.files.map((r) => r[0].split('/').slice(0, 2).join('/')).filter((t) => t.includes('/')))].sort();
  const sems = semesterOptions();
  const pending = d.items.filter((i) => i.status === 'new');
  mount(main, html`
    <div class="page-title"><h1>Classroom</h1><div class="tools">
      ${d.account ? html`<span class="note">Connected as <b>${d.account.email}</b></span><a class="btn" href="/auth/connect?account=classroom">Reconnect</a>`
        : html`<a class="btn primary" href="/auth/connect?account=classroom">Connect Google Classroom</a>`}</div></div>
    <p class="note">Each sync checks your Classroom courses for new materials, assignments and announcements with files attached. Map a course to its library folder once. Files posted after that are filed automatically, or held here if auto-publish is off. Anything posted before you mapped the course waits here for review. Links, YouTube videos, forms and your personal assignment copies are never copied.</p>
    ${d.account?.last_error ? html`<ul class="alerts"><li class="alert bad"><span>${d.account.last_error}</span><a class="btn sm" href="/auth/connect?account=classroom">Reconnect</a></li></ul>` : ''}

    <section class="block"><h2 class="h">Courses <span class="meta">${plural(d.courses.length, 'course')} found</span></h2>
      ${d.courses.length ? html`<datalist id="dl-targets">${targets.map((t) => html`<option value="${t}">`)}</datalist>
      <div class="table-scroll"><table class="t"><thead><tr><th>Classroom course</th><th>Library folder</th><th>Semester</th><th>Auto-publish</th><th></th></tr></thead><tbody>
        ${d.courses.map((c) => html`<tr data-course="${c.id}">
          <td class="wrap"><b>${c.name}</b>${c.section ? html`<span class="d muted"> · ${c.section}</span>` : ''}</td>
          <td><input class="input mono" list="dl-targets" name="target" value="${c.target || ''}" placeholder="${guessTarget(c.name)}"></td>
          <td><select class="input" name="semester"><option value="">From post date</option>${sems.map((s) => html`<option ${s === c.semester ? 'selected' : ''}>${s}</option>`)}</select></td>
          <td><label class="switch"><input type="checkbox" name="auto" ${c.auto_publish ? 'checked' : ''}>${c.auto_publish ? 'on' : 'off'}</label></td>
          <td><button class="btn sm" data-act="save-course">Save</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="empty-s">${d.account ? 'No courses yet. They’ll show up after the next sync run.' : 'Connect Classroom to see your courses.'}</p>`}
    </section>

    <section class="block"><h2 class="h">Inbox <span class="meta">${plural(pending.length, 'file')} to review ${pending.length > 1 ? html`· <button class="btn sm" data-act="approve-all">Approve all ${pending.length}</button>` : ''}</span></h2>
      ${d.items.length ? html`<div class="table-scroll"><table class="t"><thead><tr><th>Status</th><th>File</th><th>Destination</th><th></th></tr></thead><tbody>
        ${d.items.map((i) => html`<tr data-key="${i.key}">
          <td>${status(i.status)}</td>
          <td class="wrap"><a href="${i.link}" target="_blank" rel="noopener">${i.title}</a><span class="d muted">${i.course_name || ''}${i.topic ? ` · ${i.topic}` : ''} · ${i.post_title || i.post_kind}</span>${i.error ? html`<span class="d">${i.error}</span>` : ''}</td>
          <td>${i.status === 'imported' ? html`<a class="mono" href="/f/${encodePath(i.path || i.dest)}" target="_blank" rel="noopener">${i.path || i.dest}</a>` : html`<input class="input mono" name="dest" value="${i.dest || ''}">`}</td>
          <td><div class="row-acts">${i.status === 'new' || i.status === 'failed' || i.status === 'rejected' ? html`
            <button class="btn sm primary" data-act="item" data-do="approve">${icon('check')}Approve</button>
            ${i.status !== 'rejected' ? html`<button class="btn sm" data-act="item" data-do="reject">Skip</button>` : ''}` : ''}</div></td></tr>`)}
      </tbody></table></div>` : html`<p class="empty-s">Nothing has come in from Classroom yet.</p>`}
    </section>`);
}

function guessTarget(name) {
  const m = /([A-Za-z]{2,4})\s*-?\s*(\d{3,4})/.exec(name || '');
  return m ? `${m[1].toUpperCase()}${m[2]}/INITIALS` : 'CSE207/MI';
}

// --- Settings ------------------------------------------------------------------------
async function viewSettings() {
  const [s, cat] = await Promise.all([api('/settings'), loadCatalog()]);
  const courses = [...new Set(cat.files.map((r) => r[0].split('/')[0]))].sort();
  const acct = (key, label, what) => {
    const a = s.accounts[key];
    return html`<div class="panel"><h3>${label}</h3><p class="note">${what}</p>
      ${a ? html`<dl class="kv"><dt>Account</dt><dd>${a.email}</dd><dt>Connected</dt><dd>${new Date(a.connected_at).toLocaleString()}</dd>${a.last_error ? html`<dt>Problem</dt><dd>${a.last_error}</dd>` : ''}</dl><br>
        <a class="btn sm" href="/auth/connect?account=${key}">Reconnect</a> <button class="btn sm danger" data-act="disconnect" data-account="${key}">Disconnect</button>`
        : html`<a class="btn primary" href="/auth/connect?account=${key}">Connect</a>`}</div>`;
  };
  mount(main, html`
    <div class="page-title"><h1>Settings</h1></div>
    <div class="grid-2">
      ${acct('storage', 'Google Drive', 'The account that owns the library folder. The sync reads and writes through it, and the site streams Drive-only files with it.')}
      ${acct('classroom', 'Google Classroom', 'The account you take classes with. It can be the same Google account as Drive or a different one (e.g. your university account).')}
    </div>
    <section class="block"><h2 class="h">Course titles <span class="meta">shown on the site next to the code</span></h2>
      <div class="table-scroll"><table class="t"><tbody>
        ${courses.map((c) => html`<tr><td class="mono"><b>${c}</b></td><td><input class="input" data-course-title="${c}" value="${s.meta.courses[c] || ''}" placeholder="e.g. Data Structures"></td></tr>`)}
      </tbody></table></div><br><button class="btn primary" data-act="save-titles">Save titles</button>
    </section>
    <section class="block"><h2 class="h">System</h2>
      <dl class="kv"><dt>Admins</dt><dd>${s.admins.join(', ')}</dd><dt>Content repo</dt><dd><a href="https://github.com/${s.repo}">${s.repo}</a></dd>
        <dt>Drive folder</dt><dd><a href="https://drive.google.com/drive/folders/${s.driveRoot}">${s.driveRoot}</a></dd><dt>Site</dt><dd>${s.publicUrl}</dd>
        <dt>Drive-only rules</dt><dd><a href="https://github.com/${s.repo}/edit/main/.syncignore">edit .syncignore on GitHub</a></dd></dl>
      <p class="note">Admins are set by the <code>ADMIN_EMAILS</code> secret (<code>wrangler secret put ADMIN_EMAILS</code>).</p>
    </section>`);
}

// Inline text prompt in place of an element (no browser dialogs). Resolves to the value or null.
function ask(host, { value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    const saved = [...host.childNodes];
    const form = document.createElement('form');
    form.className = 'inline-edit';
    mount(form, html`<input class="input mono" value="${value}" placeholder="${placeholder}" aria-label="${placeholder || ok}"><button class="btn sm primary">${ok}</button><button type="button" class="btn sm" data-cancel>Cancel</button>`);
    host.replaceChildren(form);
    const input = form.querySelector('input');
    input.focus();
    input.select();
    const done = (v) => { host.replaceChildren(...saved); resolve(v); };
    form.addEventListener('submit', (e) => { e.preventDefault(); done(input.value.trim() || null); });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
  });
}

// --- actions (delegated) ------------------------------------------------------------
const armed = new WeakMap();
function confirmTwice(btn, label) {
  if (armed.get(btn)) return true;
  const old = btn.innerHTML;
  btn.classList.add('armed');
  btn.textContent = label;
  armed.set(btn, true);
  setTimeout(() => { armed.delete(btn); btn.classList.remove('armed'); btn.innerHTML = old; }, 4000);
  return false;
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a,button')) { location.hash = row.dataset.href; return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === 'sync') {
      b.disabled = true;
      await api('/sync', { method: 'POST', body: { dryRun: !!b.dataset.dry } });
      toast(b.dataset.dry ? 'Dry run started. Results appear here in a minute or two.' : 'Sync started on GitHub Actions');
      setTimeout(() => { b.disabled = false; }, 5000);
    } else if (act === 'approve') {
      if (!confirmTwice(b, 'Click again to approve')) return;
      await api('/sync', { method: 'POST', body: { approve: b.dataset.hash } });
      toast('Approved. The sync is running with these deletions.');
    } else if (act === 'toggle-upload') {
      const p = $('#upload'); p.hidden = !p.hidden; if (!p.hidden) $('#u-course').focus();
    } else if (act === 'mkdir') {
      const base = decodeURIComponent((location.hash.split('/files/')[1] || '').split('?')[0]);
      const name = await ask($('.browser-bar .note'), { placeholder: 'New folder name', ok: 'Create' });
      if (!name) return;
      await api('/drive/mkdir', { method: 'POST', body: { path: base ? `${base}/${name}` : name } });
      route();
    } else if (act === 'rename' || act === 'move') {
      const tr = b.closest('tr');
      const cur = tr.dataset.name;
      const base = decodeURIComponent((location.hash.split('/files/')[1] || '').split('?')[0]);
      const answer = await ask(tr.querySelector('.name-cell'), act === 'rename'
        ? { value: cur, ok: 'Rename' }
        : { value: base, placeholder: 'Library path, e.g. CSE207/MI/Lectures/Fall-26', ok: 'Move' });
      if (!answer || answer === (act === 'rename' ? cur : base)) return;
      await api('/drive/move', { method: 'POST', body: act === 'rename' ? { id: tr.dataset.id, name: answer } : { id: tr.dataset.id, toDir: answer } });
      toast(act === 'rename' ? 'Renamed' : 'Moved');
      route();
    } else if (act === 'trash') {
      if (!confirmTwice(b, 'Trash?')) return;
      const tr = b.closest('tr');
      await api('/drive/trash', { method: 'POST', body: { id: tr.dataset.id, name: tr.dataset.name } });
      toast('Moved to Drive trash (recoverable for 30 days)');
      tr.remove();
    } else if (act === 'save-course') {
      const tr = b.closest('tr');
      await api(`/classroom/courses/${tr.dataset.course}`, { method: 'PUT', body: {
        target: tr.querySelector('[name=target]').value.trim(), semester: tr.querySelector('[name=semester]').value, autoPublish: tr.querySelector('[name=auto]').checked,
      } });
      toast('Saved');
    } else if (act === 'item') {
      const tr = b.closest('tr');
      await api(`/classroom/items/${encodeURIComponent(tr.dataset.key)}`, { method: 'POST', body: {
        action: b.dataset.do, dest: tr.querySelector('[name=dest]')?.value.trim(), syncNow: b.dataset.do === 'approve',
      } });
      toast(b.dataset.do === 'approve' ? 'Approved. It will be filed on the next sync (started now).' : 'Skipped');
      route();
    } else if (act === 'approve-all') {
      if (!confirmTwice(b, 'Click again to approve all')) return;
      const rows = $('tr[data-key]').filter((tr) => tr.querySelector('[data-do=approve]') && tr.querySelector('.status[data-s=new]'));
      for (const tr of rows) {
        await api(`/classroom/items/${encodeURIComponent(tr.dataset.key)}`, { method: 'POST', body: { action: 'approve', dest: tr.querySelector('[name=dest]')?.value.trim() } });
      }
      await api('/sync', { method: 'POST', body: {} }).catch(() => {});
      toast(`Approved ${rows.length}. Filing them now.`);
      route();
    } else if (act === 'save-titles') {
      const courses = Object.fromEntries($$('[data-course-title]').map((i) => [i.dataset.courseTitle, i.value.trim()]).filter(([, v]) => v));
      await api('/settings/meta', { method: 'PUT', body: { courses } });
      toast('Titles saved');
    } else if (act === 'disconnect') {
      if (!confirmTwice(b, 'Click again to disconnect')) return;
      await api(`/accounts/${b.dataset.account}/disconnect`, { method: 'POST', body: {} });
      route();
    } else if (act === 'logout') {
      await fetch('/auth/logout', { method: 'POST' });
      location.href = '/';
    }
  } catch (err) { fail(err); b.disabled = false; }
});
document.addEventListener('change', (e) => {
  if (e.target.matches('.switch input')) e.target.nextSibling.textContent = e.target.checked ? 'on' : 'off';
});

// --- router -----------------------------------------------------------------------------
async function route() {
  const [name = 'overview', ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  $$('.side nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === name ? 'page' : 'false'));
  mount(main, html`<div class="loading">${[1, 2, 3, 4].map(() => html`<div class="skeleton"></div>`)}</div>`);
  try {
    if (name === 'sync') await viewSync(rest[0]);
    else if (name === 'files') await viewFiles(decodeURIComponent(rest.join('/')));
    else if (name === 'classroom') await viewClassroom();
    else if (name === 'settings') await viewSettings();
    else await viewOverview();
  } catch (err) {
    mount(main, html`<div class="page-title"><h1>Couldn’t load this page</h1></div><p class="note">${err.message}</p>
      ${/not connected/i.test(err.message) ? html`<a class="btn primary" href="/auth/connect?account=storage">Connect Google Drive</a>` : ''}`);
  }
}

window.addEventListener('hashchange', route);
initTheme($('#theme'));
api('/me').then((me) => { mount($('#who'), html`${me.email}<br><button data-act="logout">Sign out</button>`); }).catch(() => {});
api('/overview').then((o) => { if (o.inbox) mount($('#inbox-badge'), html`<span class="badge">${o.inbox}</span>`); }).catch(() => {});
route();
