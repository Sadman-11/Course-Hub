// Capture README screenshots with headless Chrome over the DevTools protocol
// (no dependencies; Node 22+ for the global WebSocket).
//   node scripts/screenshots.mjs <baseUrl> <outDir> [sessionCookie]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [base, outDir, session] = process.argv.slice(2);
const CHROME = process.env.CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
fs.mkdirSync(outDir, { recursive: true });

const port = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else listeners.forEach((l) => l(m));
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const loaded = () => new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });

await send('Page.enable');
await send('Network.enable');
if (session) {
  const u = new URL(base);
  await send('Network.setCookie', { name: 'ch_session', value: session, domain: u.hostname, path: '/', httpOnly: true });
}

async function shot(name, url, { width = 1440, height = 900, scale = 1, mobile = false, dark = false, js = '', wait = 1800, full = false } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  const done = loaded();
  await send('Page.navigate', { url: `${base}${url}` });
  await done;
  await send('Runtime.evaluate', { expression: 'try{localStorage.removeItem("theme")}catch{}; document.fonts.ready', awaitPromise: true });
  await sleep(wait);
  if (js) { await send('Runtime.evaluate', { expression: js, awaitPromise: true }); await sleep(700); }
  let clip;
  if (full) {
    const { contentSize } = await send('Page.getLayoutMetrics');
    clip = { x: 0, y: 0, width, height: Math.min(contentSize.height, 2600), scale: 1 };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log('  ✓', name);
}

const scrollTo = (sel) => `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:'start'}); window.scrollBy(0,-24)`;
const typeSearch = (q) => `(() => { const i = document.querySelector('#q'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`;
const jobs = JSON.parse(process.env.SHOTS || 'null') || [
  ['site-home', '/', {}],
  ['site-home-dark', '/', { dark: true }],
  ['site-index', '/', { js: scrollTo('#index') }],
  ['site-search', '/', { js: typeSearch('cse207 mid') }],
  ['site-course', '/c/CSE207/MI', {}],
  ['site-course-dark', '/c/CSE251/RDA', { dark: true }],
  ['site-file', '/f/CSE110/DAHF/Code/LAB6/Exercise1_MethodOverloading.java', {}],
  ['mobile-home', '/', { width: 390, height: 844, scale: 2, mobile: true }],
  ['mobile-course', '/c/PHY109/AROY', { width: 390, height: 844, scale: 2, mobile: true }],
  ['mobile-search-dark', '/', { width: 390, height: 844, scale: 2, mobile: true, dark: true, js: typeSearch('lab manual') }],
  ...(session ? [
    ['admin-overview', '/admin#/overview', { wait: 2500 }],
    ['admin-run', '/admin#/sync/19000000002', { wait: 2500 }],
    ['admin-classroom', '/admin#/classroom', { wait: 2500 }],
    ['admin-upload', '/admin#/files?upload=1', { wait: 2500, js: "document.querySelector('#upload') && (document.querySelector('#upload').hidden=false)" }],
  ] : []),
];
for (const [name, url, opts] of jobs) {
  try { await shot(name, url, opts); } catch (e) { console.error('  ✗', name, e.message); }
}
ws.close();
chrome.kill();
