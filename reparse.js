// Re-reads every saved API response with the current lib/bcr.js mapping.
// Use after changing which fields are saved. No browser, no Amazon traffic.
import { openDb, upsertReview } from './lib/db.js';
import { rowsFromResponse } from './lib/bcr.js';

const db = openDb();
const count = { new: 0, changed: 0, same: 0 };
let responses = 0;
for (const row of db.prepare('SELECT body FROM raw_responses ORDER BY id').iterate()) {
  responses += 1;
  let json;
  try { json = JSON.parse(row.body); } catch { continue; }
  for (const r of rowsFromResponse(json)) count[upsertReview(db, r)] += 1;
}
console.log(`Reparsed ${responses} responses:`, count);
db.close();
