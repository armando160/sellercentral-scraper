// Sends new and changed reviews to the Google Sheet's Apps Script web app
// (apps-script/Code.gs). The web app URL and token live in the Keychain
// (saved by ./setup-sheets.sh). If they're not set up, it just skips.
import { getSecret } from './secrets.js';

const BATCH = 400;

function toSheetRow(r) {
  const yn = (v) => (v === 1 ? 'Yes' : v === 0 ? 'No' : '');
  return {
    'Review ID': r.review_id,
    'Review date': r.review_date,
    'Month': r.review_date ? r.review_date.slice(0, 7) : '',
    'Stars': r.rating,
    'Title': r.title,
    'Review text': r.body,
    'Parent ASIN': r.parent_asin,
    'Child ASIN': r.child_asin,
    'Product': r.product_title,
    'Verified': yn(r.verified),
    'Vine': yn(r.vine),
    'Images': yn(r.has_images),
    'Video': yn(r.has_video),
    'Replied': yn(r.replied),
    'Done': yn(r.marked_done),
    'Link': `https://www.amazon.com/gp/customer-reviews/${r.review_id}`,
    'First seen': r.first_seen_at.slice(0, 10),
  };
}

// Returns how many reviews were sent.
export async function uploadToSheets(db, log = console.log) {
  const url = getSecret('sheets-url', { required: false });
  const token = getSecret('sheets-token', { required: false });
  if (!url || !token) { log('Google Sheets not set up, skipping upload.'); return 0; }

  const pending = db.prepare(`SELECT * FROM reviews
    WHERE uploaded_at IS NULL OR changed_at > uploaded_at ORDER BY review_date`).all();
  if (!pending.length) { log('Sheets: nothing new to upload.'); return 0; }

  const mark = db.prepare('UPDATE reviews SET uploaded_at = ? WHERE review_id = ?');
  let sent = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, rows: chunk.map(toSheetRow) }),
      redirect: 'follow',
    });
    const text = await res.text();
    let out;
    try { out = JSON.parse(text); } catch { throw new Error(`Sheets replied with non-JSON (HTTP ${res.status}). Check the web app URL and that access is "Anyone".`); }
    if (!out.ok) throw new Error(`Sheets refused: ${out.error}`);
    const ts = new Date().toISOString();
    for (const r of chunk) mark.run(ts, r.review_id);
    sent += chunk.length;
    log(`Sheets: ${out.inserted} added, ${out.updated} updated.`);
  }
  return sent;
}
