/**
 * Amazon reviews -> this Google Sheet.
 *
 * The Mac script (amazon-review-scraper) sends reviews here after each pull.
 * This adds new reviews and updates changed ones (by Review ID), and keeps
 * the "Monthly" and "By product" tabs up to date with formulas.
 *
 * Setup: see README.md, section "Google Sheets".
 * Paste the token from the Mac into TOKEN below, then Deploy > New deployment
 * > Web app > Execute as: Me > Who has access: Anyone.
 */
const TOKEN = 'PASTE-TOKEN-HERE';

const SHEET = 'Reviews';
const HEADERS = ['Review ID', 'Review date', 'Month', 'Stars', 'Title', 'Review text', 'Parent ASIN',
  'Child ASIN', 'Product', 'Verified', 'Vine', 'Images', 'Video', 'Replied', 'Done', 'Link', 'First seen'];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json_({ ok: false, error: 'bad token' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = reviewsSheet_(ss);
    const last = sh.getLastRow();
    const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map((r) => r[0]) : [];
    const rowOf = new Map(ids.map((id, i) => [id, i + 2]));

    const toAppend = [];
    let updated = 0;
    for (const r of body.rows) {
      const values = HEADERS.map((h) => safe_(r[h]));
      const at = rowOf.get(r['Review ID']);
      if (at) { sh.getRange(at, 1, 1, values.length).setValues([values]); updated++; }
      else toAppend.push(values);
    }
    if (toAppend.length) {
      sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
    }
    if (toAppend.length || updated) {
      sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).sort({ column: 2, ascending: false });
    }
    summaryTabs_(ss);
    return json_({ ok: true, inserted: toAppend.length, updated: updated });
  } finally {
    lock.releaseLock();
  }
}

// Text that starts with = + - @ would be read as a formula. Keep it as text.
function safe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function reviewsSheet_(ss) {
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET, 0);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@'); // Month stays text (2026-11)
    sh.setColumnWidth(5, 220);
    sh.setColumnWidth(6, 420);
    sh.setColumnWidth(9, 260);
  }
  return sh;
}

// Formula tabs: they recalculate by themselves when Reviews changes.
function summaryTabs_(ss) {
  if (!ss.getSheetByName('Monthly')) {
    const m = ss.insertSheet('Monthly');
    m.getRange('A1').setFormula(
      "=QUERY(Reviews!A:Q, \"select C, count(A), avg(D) where A is not null group by C order by C desc " +
      "label C 'Month', count(A) 'Reviews', avg(D) 'Avg stars'\", 1)");
    m.getRange('E1').setFormula(
      "=QUERY(Reviews!A:Q, \"select C, count(A) where A is not null group by C pivot D order by C desc " +
      "label C 'Month (count by stars)'\", 1)");
    m.getRange('C:C').setNumberFormat('0.00');
  }
  if (!ss.getSheetByName('By product')) {
    const p = ss.insertSheet('By product');
    p.getRange('A1').setFormula(
      "=QUERY(Reviews!A:Q, \"select G, count(A), avg(D) where A is not null group by G order by count(A) desc " +
      "label G 'Parent ASIN', count(A) 'Reviews', avg(D) 'Avg stars'\", 1)");
    p.getRange('E1').setFormula(
      "=QUERY(Reviews!A:Q, \"select G, count(A) where A is not null group by G pivot C " +
      "label G 'Parent ASIN (count by month)'\", 1)");
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
