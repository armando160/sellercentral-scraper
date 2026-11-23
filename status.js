// npm run status: how fresh each kind of data is.
import { openDb } from './lib/db.js';
import { statusRows, STATUS_HEAD } from './lib/status.js';

const db = openDb();
const rows = statusRows(db);
const w = STATUS_HEAD.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
console.log('\nLatest data available\n');
for (const r of [STATUS_HEAD, ...rows]) console.log(r.map((c, i) => String(c).padEnd(w[i])).join('  '));
const last = db.prepare('SELECT * FROM vc_pulls ORDER BY id DESC LIMIT 1').get();
if (last) console.log(`\nLast Vendor Central pull: ${last.started_at.slice(0, 16)} UTC, ${last.status}${last.note ? `: ${last.note}` : ''}`);
db.close();
