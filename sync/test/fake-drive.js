// A local directory that behaves like the Drive client, for integration tests
// and offline dry runs. IDs live in <root>/.ids.json so moves keep identity.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class FakeDrive {
  constructor(root) {
    this.root = root;
    this.idFile = path.join(root, '.ids.json');
    this.ids = fs.existsSync(this.idFile) ? JSON.parse(fs.readFileSync(this.idFile, 'utf8')) : {};
  }

  save() { fs.writeFileSync(this.idFile, JSON.stringify(this.ids, null, 1)); }
  idFor(rel) {
    if (!this.ids[rel]) { this.ids[rel] = crypto.randomUUID(); this.save(); }
    return this.ids[rel];
  }
  relFor(id) { return Object.keys(this.ids).find((k) => this.ids[k] === id); }

  async tree() {
    const files = new Map();
    const folders = new Map([['', 'root']]);
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.ids.json' || e.name === '.trash') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { folders.set(r, `dir:${r}`); walk(full, r); continue; }
        const buf = fs.readFileSync(full);
        const st = fs.statSync(full);
        files.set(r, {
          id: this.idFor(r), md5: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length,
          mtime: st.mtime.toISOString(), ctime: st.birthtime.toISOString(), export: null,
        });
      }
    };
    walk(this.root, '');
    return { files, folders, issues: [] };
  }

  async download(entry, dest) { fs.copyFileSync(path.join(this.root, this.relFor(entry.id)), dest); }
  async ensureFolder(dir, folders) {
    fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    folders.set(dir, `dir:${dir}`);
    return `dir:${dir}`;
  }
  meta(rel) {
    const buf = fs.readFileSync(path.join(this.root, rel));
    return { id: this.idFor(rel), md5Checksum: crypto.createHash('md5').update(buf).digest('hex'), size: String(buf.length), modifiedTime: new Date().toISOString() };
  }
  async upload(name, parentId, buf) {
    const rel = `${parentId.slice(4)}/${name}`.replace(/^\//, '');
    fs.writeFileSync(path.join(this.root, rel), buf);
    return this.meta(rel);
  }
  async updateContent(id, buf) {
    const rel = this.relFor(id);
    fs.writeFileSync(path.join(this.root, rel), buf);
    return this.meta(rel);
  }
  async move(id, { name, addParent }) {
    const from = this.relFor(id);
    const to = `${addParent.slice(4)}/${name}`.replace(/^\//, '');
    fs.renameSync(path.join(this.root, from), path.join(this.root, to));
    delete this.ids[from];
    this.ids[to] = id;
    this.save();
    return this.meta(to);
  }
  async children(id) {
    const rel = id === 'root' ? '' : id.slice(4);
    return fs.readdirSync(path.join(this.root, rel), { withFileTypes: true })
      .filter((e) => e.name !== '.ids.json' && e.name !== '.trash')
      .map((e) => ({ id: e.isDirectory() ? `dir:${rel ? `${rel}/` : ''}${e.name}` : this.idFor(`${rel ? `${rel}/` : ''}${e.name}`), name: e.name }));
  }
  async trash(id) {
    if (id.startsWith('dir:')) { fs.rmdirSync(path.join(this.root, id.slice(4))); return; }
    const rel = this.relFor(id);
    const t = path.join(this.root, '.trash');
    fs.mkdirSync(t, { recursive: true });
    fs.renameSync(path.join(this.root, rel), path.join(t, id));
    delete this.ids[rel];
    this.save();
  }
}
