// Talks to the Worker's internal API (run reports, catalog, Classroom state).
export class Reporter {
  constructor(env) {
    this.base = (env.SYNC_API || '').replace(/\/$/, '');
    this.token = env.SYNC_TOKEN;
    this.enabled = Boolean(this.base && this.token);
  }

  async call(method, path, body) {
    if (!this.enabled) return null;
    const res = await fetch(`${this.base}/api/internal${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`worker ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }

  async run(report) {
    try { await this.call('POST', '/runs', report); } catch (e) { console.warn('report failed:', e.message); }
  }

  async catalog(catalog) {
    try { await this.call('PUT', '/catalog', catalog); } catch (e) { console.warn('catalog upload failed:', e.message); }
  }

  classroomConfig() { return this.call('GET', '/classroom'); }
  classroomItems(payload) { return this.call('POST', '/classroom/items', payload); }
  classroomResults(payload) { return this.call('POST', '/classroom/results', payload); }
}
