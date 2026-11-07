import { html, raw, mount, $, $$, bytes, day, ago, plural, tag, icon, toast, copy, initTheme, encodePath, extOf, TEXT_EXT, IMAGE_EXT } from './lib.js';
import { CATEGORIES, semesterKey, parseSemester } from './taxonomy.js';

const DEPARTMENTS = {
  CSE: 'Computer Science & Engineering', MAT: 'Mathematics', PHY: 'Physics', CHE: 'Chemistry',
  ENG: 'English', ECO: 'Economics', STA: 'Statistics', BUS: 'Business', EEE: 'Electrical & Electronic Engineering',
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const app = $('#app');
const S = { files: [], byPath: new Map(), courses: new Map(), meta: { courses: {}, instructors: {} }, repo: '', loaded: false };

// --- data ---------------------------------------------------------------------
async function load() {
  const res = await fetch('/api/catalog');
  const j = await res.json();
  S.repo = j.repo;
  S.meta = j.meta || S.meta;
  S.files = (j.files || []).map(([path, size, mtime, ctime, id, gh]) => {
    const parts = path.split('/');
    const name = parts[parts.length - 1];
    const course = parts[0];
    const instructor = parts.length > 2 ? parts[1] : 'General';
    const sub = parts.slice(parts.length > 2 ? 2 : 1, -1);
    const instName = S.meta.instructors[instructor] || '';
    return {
      path, size, mtime, ctime: ctime || mtime, id, gh: !!gh, name, course, instructor, sub,
      hay: `${path.toLowerCase().replace(/[/_\-.]+/g, ' ')} ${instName.toLowerCase()}`,
      nameLc: name.toLowerCase(),
    };
  });
  S.byPath = new Map(S.files.map((f) => [f.path, f]));
  S.courses = new Map();
  for (const f of S.files) {
    if (!S.courses.has(f.course)) S.courses.set(f.course, { code: f.course, files: [], instructors: new Map() });
    const c = S.courses.get(f.course);
    c.files.push(f);
    if (!c.instructors.has(f.instructor)) c.instructors.set(f.instructor, []);
    c.instructors.get(f.instructor).push(f);
  }
  S.loaded = true;
  fetch('/api/status').then((r) => r.json()).then((st) => {
    const el = $('#sync-status');
    if (el && st.lastSync) mount(el, html`<span class="dot ${st.status === 'ok' ? '' : 'warn'}"></span>Synced ${ago(st.lastSync)}`);
  }).catch(() => {});
}

// --- search -----------------------------------------------------------------------
const norm = (q) => q.toLowerCase().replace(/\b([a-z]{3})\s+(\d{3,4})\b/g, '$1$2').replace(/[^\p{L}\p{N}\s.]+/gu, ' ').trim();
function search(q) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const out = [];
  for (const f of S.files) {
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      const inName = f.nameLc.includes(t);
      if (inName) score += f.nameLc.startsWith(t) ? 6 : 4;
      else if (f.course.toLowerCase() === t || f.instructor.toLowerCase() === t) score += 3;
      else if (f.hay.includes(t)) score += 1;
      else { ok = false; break; }
    }
    if (ok) out.push([score + new Date(f.ctime).getTime() / 1e13, f]);
  }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 80).map((x) => x[1]);
}
function highlight(name, q) {
  const tokens = norm(q).split(/\s+/).filter((t) => t.length > 1);
  if (!tokens.length) return html`${name}`;
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return raw(name.split(re).map((part, i) => (i % 2 ? `<mark>${escapeText(part)}</mark>` : escapeText(part))).join(''));
}
const escapeText = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// --- shared pieces ----------------------------------------------------------------------
const fileUrl = (f) => `/f/${encodePath(f.path)}`;
const shareUrl = (f) => `${location.origin}${fileUrl(f)}`;

function fileRow(f, { where = false, q = '' } = {}) {
  const loc = [f.course, f.instructor, ...f.sub].join(' / ');
  return html`<li class="file">
    ${tag(f.name)}
    <div class="grow">
      <a class="name" href="${fileUrl(f)}" data-link title="${f.name}">${q ? highlight(f.name, q) : f.name}</a>
      ${where ? html`<span class="where">${loc}</span>` : ''}
    </div>
    <span class="size">${bytes(f.size)}</span>
    <span class="date" title="Added ${new Date(f.ctime).toLocaleString()}">${day(f.ctime)}</span>
    <span class="acts">
      <a class="icon-btn" href="/dl/${encodePath(f.path)}" title="Download" aria-label="Download ${f.name}">${icon('download')}</a>
      <button class="icon-btn" data-share="${f.path}" title="Copy link" aria-label="Copy link to ${f.name}">${icon('link')}</button>
    </span>
  </li>`;
}

function courseTitle(code) { return S.meta.courses[code] || ''; }

// --- views --------------------------------------------------------------------------------
function viewHome(params) {
  const q = params.get('q') || '';
  const total = S.files.length;
  document.title = 'Course Materials';
  mount(app, html`
    <section class="wrap lede">
      <h1>Find a lecture, a lab manual, or <em>last term’s mid</em>.</h1>
      <div class="search">
        <label class="sr-only" for="q">Search all files</label>
        <input id="q" type="search" autocomplete="off" spellcheck="false" value="${q}"
          placeholder="Search ${total.toLocaleString()} files by course, instructor or name">
        <kbd aria-hidden="true">/</kbd>
      </div>
      <p class="hints">Try <span><button data-q="CSE207 mid">CSE207 mid</button></span><span><button data-q="Sedra">Sedra</button></span><span><button data-q="lab manual">lab manual</button></span><span><button data-q="PHY109 optics">PHY109 optics</button></span></p>
    </section>
    <div id="results" class="wrap"></div>
    <div id="home-body"></div>`);

  const input = $('#q');
  const results = $('#results');
  const body = $('#home-body');
  const renderResults = () => {
    const v = input.value.trim();
    history.replaceState(null, '', v ? `/?q=${encodeURIComponent(v)}` : '/');
    if (!v) { results.innerHTML = ''; body.hidden = false; return; }
    body.hidden = true;
    const hits = search(v);
    mount(results, html`<section class="section">
      <div class="kicker"><h2>Results</h2><span class="meta">${hits.length === 80 ? 'top 80' : plural(hits.length, 'file')}</span></div>
      ${hits.length ? html`<ul class="files">${hits.map((f) => fileRow(f, { where: true, q: v }))}</ul>`
        : html`<p class="empty">Nothing matches “${v}”. Try a course code like CSE207, or fewer words.</p>`}
    </section>`);
  };
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderResults, 60); });
  $$('[data-q]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.q; renderResults(); input.focus(); }));

  // Index + recent
  const depts = new Map();
  for (const c of [...S.courses.values()].sort((a, b) => collator.compare(a.code, b.code))) {
    const d = (/^[A-Z]+/.exec(c.code) || ['Other'])[0];
    if (!depts.has(d)) depts.set(d, []);
    depts.get(d).push(c);
  }
  const recent = [...S.files].sort((a, b) => b.ctime.localeCompare(a.ctime)).slice(0, 10);
  mount(body, html`
    <section class="wrap section" id="index">
      <div class="kicker"><h2>Index</h2><span class="meta">${plural(S.courses.size, 'course')} · ${plural(new Set(S.files.map((f) => f.instructor)).size, 'instructor')} · ${plural(total, 'file')}</span></div>
      <div class="toc">${[...depts].map(([d, courses]) => html`
        <div class="dept"><h3>${DEPARTMENTS[d] || d}</h3>
          ${courses.map((c) => {
            const title = courseTitle(c.code);
            const inst = [...c.instructors.keys()].filter((i) => i !== 'General');
            return html`<a class="toc-row" href="/c/${c.code}" data-link>
              <span class="code">${c.code}</span>
              <span class="title ${title ? '' : 'muted'}">${title || inst.join(' · ')}</span>
              <span class="leader"></span>
              <span class="count">${c.files.length}</span></a>`;
          })}
        </div>`)}
      </div>
    </section>
    <section class="wrap section">
      <div class="kicker"><h2>Recently added</h2><a class="meta" href="/recent" data-link>all recent →</a></div>
      <ul class="files">${recent.map((f) => fileRow(f, { where: true }))}</ul>
    </section>`);
  if (q) renderResults();
  if (!q && matchMedia('(min-width: 900px)').matches) input.focus({ preventScroll: true });
}

function sections(files) {
  // Top-level folder under the instructor = category (canonical layout), in canonical order.
  const top = new Map();
  for (const f of files) {
    const key = f.sub[0] || '';
    if (!top.has(key)) top.set(key, []);
    top.get(key).push(f);
  }
  const order = (k) => (k === '' ? 999 : CATEGORIES.includes(k) ? CATEGORIES.indexOf(k) : 100);
  return [...top].sort(([a], [b]) => order(a) - order(b) || collator.compare(a, b)).map(([key, list]) => {
    const groups = new Map();
    for (const f of list) {
      const rest = f.sub.slice(1).join(' / ');
      if (!groups.has(rest)) groups.set(rest, []);
      groups.get(rest).push(f);
    }
    const semOf = (g) => parseSemester(g.split(' / ')[0] || '') ? semesterKey(g.split(' / ')[0]) : -1;
    const sorted = [...groups].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : semOf(b) - semOf(a) || collator.compare(a, b)));
    return { key, label: key || 'Other files', count: list.length, groups: sorted.map(([g, fs]) => [g, fs.sort((x, y) => collator.compare(x.name, y.name))]) };
  });
}

function viewCourse(code, instructor) {
  const c = S.courses.get(code);
  if (!c) return viewMissing(`No course called ${code}.`);
  const insts = [...c.instructors.entries()].sort((a, b) => b[1].length - a[1].length);
  const current = instructor && c.instructors.has(instructor) ? instructor : insts[0][0];
  const title = courseTitle(code);
  document.title = `${code}${title ? ` · ${title}` : ''} — Course Materials`;
  const secs = sections(c.instructors.get(current));
  mount(app, html`<div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>Index</a><i>/</i><span>${code}</span></nav>
    <header class="course-head">
      <div><div class="code">${code}</div>${title ? html`<div class="title">${title}</div>` : ''}</div>
      <div class="stats"><div><b>${c.files.length}</b>files</div><div><b>${insts.length}</b>${insts.length === 1 ? 'instructor' : 'instructors'}</div><div><b>${bytes(c.files.reduce((s, f) => s + f.size, 0))}</b>total</div></div>
    </header>
    <nav class="instructors" aria-label="Instructors">${insts.map(([i, fs]) => html`
      <a href="/c/${code}/${encodeURIComponent(i)}" data-link aria-current="${i === current}"><b>${i}</b><span>${S.meta.instructors[i] || (i === 'General' ? 'Course-wide' : '')}${S.meta.instructors[i] || i === 'General' ? ' · ' : ''}${fs.length}</span></a>`)}
    </nav>
    ${secs.map((s) => html`<section class="cat" id="${s.key || 'other'}">
      <header><h2>${s.label}</h2><span class="n">${s.count}</span><span class="rule"></span></header>
      ${s.groups.map(([g, fs]) => html`${g ? html`<div class="group-label">${g}</div>` : ''}<ul class="files">${fs.map((f) => fileRow(f))}</ul>`)}
    </section>`)}
  </div>`);
}

function viewFile(path) {
  const f = S.byPath.get(path);
  if (!f) return viewMissing('That file isn’t in the library (it may have been moved or renamed).');
  document.title = `${f.name} · ${f.course} — Course Materials`;
  const ext = extOf(f.name);
  const raw = `/raw/${encodePath(f.path)}`;
  const siblings = S.files.filter((x) => x.path !== f.path && x.path.slice(0, x.path.lastIndexOf('/')) === f.path.slice(0, f.path.lastIndexOf('/')))
    .sort((a, b) => collator.compare(a.name, b.name)).slice(0, 30);
  let preview;
  if (IMAGE_EXT.has(ext)) preview = html`<img src="${raw}" alt="${f.name}">`;
  else if (TEXT_EXT.has(ext) && f.size < 400_000) preview = html`<pre id="code" aria-label="File contents"><span>Loading…</span></pre>`;
  else if (f.id) preview = html`<iframe src="https://drive.google.com/file/d/${f.id}/preview" title="Preview of ${f.name}" loading="lazy" allow="autoplay" referrerpolicy="no-referrer"></iframe>`;
  else if (ext === 'pdf') preview = html`<iframe src="${raw}" title="Preview of ${f.name}" loading="lazy"></iframe>`;
  else preview = html`<div class="none">No preview for this file type.</div>`;

  mount(app, html`<div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>Index</a><i>/</i><a href="/c/${f.course}" data-link>${f.course}</a><i>/</i><a href="/c/${f.course}/${encodeURIComponent(f.instructor)}" data-link>${f.instructor}</a>${f.sub.map((s) => html`<i>/</i><span>${s}</span>`)}</nav>
    <header class="file-head">
      <h1>${f.name}</h1>
      <div class="facts">${tag(f.name)}<span>${bytes(f.size)}</span><span>added ${day(f.ctime)}</span>${f.mtime !== f.ctime ? html`<span>updated ${day(f.mtime)}</span>` : ''}<span>${S.meta.instructors[f.instructor] || f.instructor}</span></div>
      <div class="actions">
        <a class="btn primary" href="/dl/${encodePath(f.path)}">${icon('download')}Download</a>
        <button class="btn" data-share="${f.path}">${icon('link')}Copy link</button>
        ${navigator.share ? html`<button class="btn" data-native-share="${f.path}">${icon('share')}Share</button>` : ''}
        ${f.id ? html`<a class="btn" href="https://drive.google.com/file/d/${f.id}/view" target="_blank" rel="noopener">${icon('drive')}Open in Drive</a>` : ''}
        ${f.gh && S.repo ? html`<a class="btn" href="https://github.com/${S.repo}/blob/main/${encodePath(f.path)}" target="_blank" rel="noopener">${icon('github')}GitHub</a>` : ''}
      </div>
    </header>
    <div class="preview">${preview}</div>
    ${f.id && !TEXT_EXT.has(ext) && !IMAGE_EXT.has(ext) ? html`<p class="preview-note">Preview by Google Drive. If it doesn’t load, use Download.</p>` : ''}
    ${siblings.length ? html`<section class="section"><div class="kicker"><h2>In this folder</h2><span class="meta">${plural(siblings.length, 'other file')}</span></div><ul class="files">${siblings.map((x) => fileRow(x))}</ul></section>` : ''}
  </div>`);

  const pre = $('#code');
  if (pre) {
    fetch(raw).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((text) => {
      mount(pre, html`${text.replace(/\r\n?/g, '\n').split('\n').map((l) => html`<span>${l || ' '}</span>`)}`);
    }).catch(() => mount(pre, html`<span>Couldn’t load the file.</span>`));
  }
}

function viewRecent() {
  document.title = 'Recently added — Course Materials';
  const list = [...S.files].sort((a, b) => b.ctime.localeCompare(a.ctime)).slice(0, 150);
  const byDay = new Map();
  for (const f of list) {
    const k = f.ctime.slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(f);
  }
  mount(app, html`<div class="wrap">
    <nav class="crumbs"><a href="/" data-link>Index</a><i>/</i><span>Recent</span></nav>
    <section class="section"><div class="kicker"><h2>Recently added</h2><span class="meta">last ${list.length} files</span></div>
    ${[...byDay].map(([d, fs]) => html`<div class="group-label">${new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</div><ul class="files">${fs.map((f) => fileRow(f, { where: true }))}</ul>`)}
    </section></div>`);
}

function viewAbout() {
  document.title = 'About — Course Materials';
  mount(app, html`<div class="wrap prose">
    <h1>About this library</h1>
    <p>Lecture slides, lab manuals, question papers, assignments and books for East West University courses, collected by students and kept in one place.</p>
    <h2>How it’s organised</h2>
    <p>Every course follows the same layout:</p>
    <pre>COURSE / INSTRUCTOR / Category / Semester / file</pre>
    <p>Categories always appear in this order: ${CATEGORIES.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}. Instructors are listed by their faculty initials.</p>
    <h2>Where the files live</h2>
    <p>The master copy is a Google Drive folder. Every 30 minutes it’s mirrored to ${S.repo ? html`<a href="https://github.com/${S.repo}">GitHub</a>` : 'GitHub'}, and this site reads from both. Files over 100 MB are served from Drive only.</p>
    <h2>Something shouldn’t be here?</h2>
    <p>Materials belong to their instructors and authors. If you’d like something removed or corrected, ${S.repo ? html`<a href="https://github.com/${S.repo}/issues/new">open an issue</a>` : 'contact the maintainer'} and it will be taken down.</p>
  </div>`);
}

function viewMissing(msg = 'There’s nothing at this address.') {
  document.title = 'Not found — Course Materials';
  mount(app, html`<div class="wrap"><p class="empty">${msg} <a href="/" data-link>Back to the index</a>.</p></div>`);
}

// --- router -------------------------------------------------------------------------------
function route() {
  const url = new URL(location.href);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  $$('.nav a').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === url.pathname ? 'page' : 'false'));
  if (!parts.length) viewHome(url.searchParams);
  else if (parts[0] === 'c' && parts[1]) viewCourse(parts[1].toUpperCase(), parts[2]);
  else if (parts[0] === 'f' && parts.length > 1) viewFile(parts.slice(1).join('/'));
  else if (parts[0] === 'recent') viewRecent();
  else if (parts[0] === 'about') viewAbout();
  else viewMissing();
}

function navigate(href) {
  history.pushState(null, '', href);
  route();
  window.scrollTo(0, 0);
}

document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
    return;
  }
  const share = e.target.closest('[data-share]');
  if (share) {
    const f = S.byPath.get(share.dataset.share);
    if (f && (await copy(shareUrl(f)))) toast('Link copied');
    return;
  }
  const ns = e.target.closest('[data-native-share]');
  if (ns) {
    const f = S.byPath.get(ns.dataset.nativeShare);
    try { await navigator.share({ title: f.name, text: `${f.name} — ${f.course}`, url: shareUrl(f) }); } catch { /* dismissed */ }
  }
});
window.addEventListener('popstate', route);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
    e.preventDefault();
    if (location.pathname !== '/') navigate('/');
    $('#q')?.focus();
  } else if (e.key === 'Escape' && document.activeElement.id === 'q') {
    const q = $('#q');
    q.value = '';
    q.dispatchEvent(new Event('input'));
  }
});

initTheme($('#theme'));
mount(app, html`<div class="wrap loading">${[1, 2, 3, 4, 5].map(() => html`<div class="skeleton"></div>`)}</div>`);
load().then(route).catch((e) => {
  console.error(e);
  mount(app, html`<div class="wrap"><p class="empty">The library couldn’t be loaded. Refresh to try again.</p></div>`);
});
