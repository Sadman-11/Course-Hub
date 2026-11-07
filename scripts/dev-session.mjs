// Local development only: mint an admin session cookie signed with the
// SESSION_SECRET in .dev.vars, so the dashboard can be used without Google.
//   node scripts/dev-session.mjs you@example.com
import fs from 'node:fs';
import { createHmac } from 'node:crypto';

const email = (process.argv[2] || '').toLowerCase();
if (!email) { console.error('usage: dev-session.mjs <admin email>'); process.exit(2); }
const secret = /SESSION_SECRET\s*=\s*"?([^"\n]+)/.exec(fs.readFileSync('.dev.vars', 'utf8'))[1];
const body = Buffer.from(JSON.stringify({ email, name: 'Local admin', exp: Date.now() + 86400e3 })).toString('base64url');
const sig = createHmac('sha256', secret).update(body).digest('base64url');
console.log(`${body}.${sig}`);
