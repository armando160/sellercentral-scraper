/**
 * Amazon reviews -> this Google Sheet.
 *
 * The Mac script (amazon-review-scraper) sends reviews here after each pull.
 * This adds new reviews and updates changed ones (by Review ID), and keeps
 * the "Monthly" and "By product" tabs up to date with formulas.
 *
 * It also sends the status emails (Sunday check, Monday result, errors) and
 * emails you on Monday morning if the Mac never reported in.
 *
 * Setup: see README.md, section "Google Sheets" and "Email alerts".
 * Paste the token from the Mac into TOKEN below, then Deploy > New deployment
 * > Web app > Execute as: Me > Who has access: Anyone.
 */
const TOKEN = 'PASTE-TOKEN-HERE';

// Who gets the status emails. Separate several with commas.
const EMAIL_TO = 'armando@chaivision.com';

const SHEET = 'Reviews';
const HEADERS = ['Review ID', 'Review date', 'Month', 'Stars', 'Title', 'Review text', 'Parent ASIN',
  'Child ASIN', 'Product', 'Verified', 'Vine', 'Images', 'Video', 'Replied', 'Done', 'Link', 'First seen'];

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json_({ ok: false, error: 'bad token' });

  // Status email from the Mac: { email: { subject, text, kind } }
  if (body.email) {
    MailApp.sendEmail({ to: EMAIL_TO, subject: body.email.subject, body: body.email.text, name: 'Amazon reviews scraper' });
    if (body.email.kind === 'pull') {
      PropertiesService.getScriptProperties().setProperty('lastPullAt', new Date().toISOString());
    }
    return json_({ ok: true, emailed: true });
  }

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

// ---- Missed-run check (runs on Google's side, so it works even if the Mac is dead) ----

// Run this ONCE from the editor (select it, click Run). It schedules
// checkMissedRun for every Monday around 9am.
function setupMissedRunCheck() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkMissedRun')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkMissedRun').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).everyWeeks(1).create();
  MailApp.sendEmail(EMAIL_TO, 'Amazon reviews: missed-run check is on',
    'Every Monday around 9am Google will check that the Mac sent its 6am pull result. ' +
    'If it did not, you will get an email.');
}

function checkMissedRun() {
  const last = PropertiesService.getScriptProperties().getProperty('lastPullAt');
  const hours = last ? (Date.now() - new Date(last).getTime()) / 36e5 : Infinity;
  if (hours > 12) {
    MailApp.sendEmail(EMAIL_TO, 'Amazon reviews: Monday pull DID NOT RUN',
      'The Mac did not report a pull this morning' +
      (last ? ' (last report: ' + last.slice(0, 16).replace('T', ' ') + ' UTC).' : '.') + '\n\n' +
      'Usually: the Mac was off, asleep without power, or the lid was closed.\n\n' +
      'Fix: open the Mac, plug it in, then in Terminal:\n' +
      '  cd amazon-review-scraper\n  npm run pull');
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
