/**
 * Amazon reviews -> this Google Sheet.
 *
 * The Mac script (sellercentral-scraper) sends reviews here after each pull.
 * This adds new reviews and updates changed ones (by Review ID), keeps the
 * "By product" tab up to date, and the "Monthly" tab recalculates by itself.
 *
 * It also sends the status emails (night-before checks, pull results, errors)
 * and emails you on Monday and Tuesday morning if the Mac never reported in.
 *
 * Setup: see README.md, sections "Google Sheets" and "Email alerts".
 *   1. Paste the token from the Mac into TOKEN below.
 *   2. Run setup() once from the editor (select it, click Run). It moves the
 *      sheet to the new layout, builds the tabs and turns on the missed-run check.
 *   3. Deploy > Manage deployments > edit > Version: New version > Deploy.
 *      (First time: Deploy > New deployment > Web app > Execute as: Me >
 *      Who has access: Anyone.)
 */
const TOKEN = 'PASTE-TOKEN-HERE';

// Who gets the status emails. Separate several with commas.
const EMAIL_TO = 'armando@chaivision.com';

const SHEET = 'Reviews';
const BACKUP = 'Reviews (old layout backup)'; // the old Reviews tab, kept hidden after the layout change
const HEADERS = ['Review ID', 'Review date', 'Month', 'Brand', 'Marketplace', 'Stars', 'Title', 'Review text',
  'Parent ASIN', 'Child ASIN', 'Product', 'Verified', 'Vine', 'Images', 'Video', 'Replied', 'Done', 'Link', 'First seen'];
// Column letters in the Reviews tab, used by the formulas.
const COL = { month: 'C', brand: 'D', market: 'E', stars: 'F' };

const BRANDS = ['Lifepro', 'Joyberri', 'Sunello'];
const MARKETS = ['US', 'CA', 'MX', 'UK', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'SE', 'PL', 'AE', 'SA', 'TR'];
const MONTHS = 12; // month columns per table on the Monthly tab

// Colors
const C = { navy: '#1F3A5F', navyText: '#FFFFFF', light: '#EEF3F8', line: '#C9D6E3', muted: '#5F6B7A',
  red: '#F4C7C3', yellow: '#FFF2CC', green: '#D9EAD3', total: '#DCE6F1' };

// ---------------------------------------------------------------- web app

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.token !== TOKEN) return json_({ ok: false, error: 'bad token' });

  // Keepa history copy for the Mac: { keepa: {} }. Read only.
  if (body.keepa) return json_(keepaExport_());

  // Status email from the Mac: { email: { subject, text, html, kind } }
  if (body.email) {
    const mail = { to: EMAIL_TO, subject: body.email.subject, body: body.email.text, name: 'Amazon reviews scraper' };
    if (body.email.html) mail.htmlBody = body.email.html; // tables; the plain text is the fallback
    MailApp.sendEmail(mail);
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
      const start = sh.getLastRow() + 1;
      const need = start + toAppend.length - 1 - sh.getMaxRows();
      if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 1000); // room to grow
      sh.getRange(start, 1, toAppend.length, HEADERS.length).setValues(toAppend);
      fitFilter_(sh);
    }
    if (toAppend.length || updated) sortReviews_(sh);
    if (!ss.getSheetByName('Monthly')) buildMonthly_(ss);
    buildByProduct_(ss);
    stampUpdated_(ss);
    return json_({ ok: true, inserted: toAppend.length, updated: updated });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- Keepa copy

// The teammate's "Review History - Keepa" sheet. The Mac copies three tabs
// into its database (lib/keepa.js). This only READS that sheet.
// The ID is not in this public repo: ./setup-sheets.sh script fills it in from the Keychain (keepa-sheet-id).
const KEEPA_SHEET_ID = 'PASTE-KEEPA-SHEET-ID-HERE';

function keepaExport_() {
  const ss = SpreadsheetApp.openById(KEEPA_SHEET_ID); // only this sheet, whatever the request says
  const tab = (name) => { const sh = ss.getSheetByName(name); return sh ? sh.getDataRange().getDisplayValues() : null; };
  const runs = ss.getSheetByName('Runs');
  return {
    ok: true,
    read_at: new Date().toISOString(),
    keepa_updated: runs ? runs.getRange('B3').getDisplayValue() : null, // "Last successful update", Karachi time
    state: tab('_state'),
    meta: tab('_meta'),
    sku_view: tab('ASIN-SKU-View'),
  };
}

// Run this once from the editor after pasting the new code: Google asks to
// allow reading other spreadsheets. Then deploy a new version.
function authorizeKeepa() {
  const out = keepaExport_();
  Logger.log('Keepa sheet readable: ' + (out.state ? out.state.length - 1 : 0) + ' month rows, updated ' + out.keepa_updated);
}

// Text that starts with = + - @ would be read as a formula. Keep it as text.
function safe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- setup

// Run ONCE from the editor after pasting a new version of this script.
// Safe to run again: it rebuilds the Monthly and By product tabs and the
// styling, and never deletes reviews.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = reviewsSheet_(ss);
  carryOverFromBackup_(ss);
  styleReviews_(sh);
  sortReviews_(sh);
  buildMonthly_(ss);
  buildByProduct_(ss);
  stampUpdated_(ss);
  ss.setActiveSheet(ss.getSheetByName('Monthly'));
  setupMissedRunCheck();
}

// Returns the Reviews tab in the current layout. If it has the old layout
// (no Brand / Marketplace), it copies every review into a new Reviews tab
// (old rows = Lifepro / US) and keeps the old one hidden as a backup.
function reviewsSheet_(ss) {
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET, 0);
    sh.getRange('C:C').setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    styleReviews_(sh);
    return sh;
  }
  const width = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, width).getValues()[0];
  if (head.slice(0, HEADERS.length).join('|') === HEADERS.join('|')) return sh;

  // Old layout: rebuild by column name.
  const idx = {};
  head.forEach((h, i) => { idx[h] = i; });
  const last = sh.getLastRow();
  const old = last > 1 ? sh.getRange(2, 1, last - 1, width).getValues() : [];
  const tz = ss.getSpreadsheetTimeZone();
  const rows = old.filter((r) => r[idx['Review ID']]).map((r) => HEADERS.map((h) => {
    if (h in idx) {
      const v = r[idx[h]];
      if (h === 'Month' && v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM');
      return v;
    }
    if (h === 'Brand') return 'Lifepro';
    if (h === 'Marketplace') return 'US';
    return '';
  }));

  const oldBackup = ss.getSheetByName(BACKUP);
  if (oldBackup) ss.deleteSheet(oldBackup);
  sh.setName(BACKUP);
  sh.hideSheet();

  const fresh = ss.insertSheet(SHEET, 0);
  fresh.getRange('C:C').setNumberFormat('@');
  fresh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  if (rows.length) {
    if (rows.length + 1 > fresh.getMaxRows()) fresh.insertRowsAfter(fresh.getMaxRows(), rows.length + 1 - fresh.getMaxRows());
    fresh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  }
  styleReviews_(fresh);
  // The old summary tabs pointed at the old layout: rebuild them.
  ['Monthly', 'By product'].forEach((n) => { const t = ss.getSheetByName(n); if (t) ss.deleteSheet(t); });
  return fresh;
}

// Number of columns in Reviews: the scraper's own (HEADERS) plus any columns
// people added to the right (e.g. Category, Issue). Those move with their rows.
function width_(sh) {
  return Math.max(HEADERS.length, sh.getLastColumn());
}

// Newest first. Sorts every column, so added columns stay with their review.
// The filter is taken off for the sort and put back (its picks are reset).
function sortReviews_(sh) {
  const n = sh.getLastRow() - 1;
  if (n < 2) return;
  const f = sh.getFilter();
  if (f) f.remove();
  sh.getRange(2, 1, n, width_(sh)).sort([{ column: 2, ascending: false }, { column: 1, ascending: true }]);
  if (f) fitFilter_(sh);
}

// The filter must cover every row and every column. Recreate it if not.
function fitFilter_(sh) {
  const f = sh.getFilter();
  const w = width_(sh);
  if (f && f.getRange().getLastRow() >= sh.getMaxRows() && f.getRange().getNumColumns() === w) return;
  if (f) f.remove();
  sh.getRange(1, 1, sh.getMaxRows(), w).createFilter();
}

// After the layout change: copies columns people added to the old Reviews tab
// (anything not in HEADERS, e.g. Category, Issue) into the new one, matched by
// Review ID, and points other tabs' formulas from the backup to the new tab.
// Safe to run again: columns already there are skipped.
function carryOverFromBackup_(ss) {
  const bk = ss.getSheetByName(BACKUP);
  const sh = ss.getSheetByName(SHEET);
  if (!bk || !sh) return;
  const bw = bk.getLastColumn();
  const bHead = bk.getRange(1, 1, 1, bw).getValues()[0];
  const head = sh.getRange(1, 1, 1, width_(sh)).getValues()[0];

  const extras = [];
  bHead.forEach((h, i) => { if (h && HEADERS.indexOf(h) < 0 && head.indexOf(h) < 0) extras.push({ h: h, i: i }); });
  if (extras.length) {
    const bLast = bk.getLastRow();
    const bData = bLast > 1 ? bk.getRange(2, 1, bLast - 1, bw).getValues() : [];
    const idCol = bHead.indexOf('Review ID');
    const byId = new Map(bData.map((r) => [r[idCol], r]));
    const last = sh.getLastRow();
    const ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map((r) => r[0]) : [];
    const startCol = width_(sh) + 1;
    const block = [extras.map((x) => x.h)].concat(ids.map((id) => {
      const r = byId.get(id);
      return extras.map((x) => (r ? r[x.i] : ''));
    }));
    const f = sh.getFilter();
    if (f) f.remove();
    sh.getRange(1, startCol, block.length, extras.length).setValues(block);
    sh.getRange(1, startCol, 1, extras.length).setBackground('#5F6B7A').setFontColor('#FFFFFF').setFontWeight('bold');
    fitFilter_(sh);
  }

  // Point formulas in other tabs from the backup to the new Reviews tab,
  // translating each column by its header name.
  const newHead = sh.getRange(1, 1, 1, width_(sh)).getValues()[0];
  const map = {};
  bHead.forEach((h, i) => { const j = newHead.indexOf(h); if (h && j >= 0) map[colLetter_(i + 1)] = colLetter_(j + 1); });
  const ref = /'Reviews \(old layout backup\)'!(\$?[A-Z]+\$?\d*)(?::(\$?[A-Z]+\$?\d*))?/g;
  const cell = (c) => c.replace(/^(\$?)([A-Z]+)/, (m, d, col) => d + (map[col] || col));
  const known = (c) => !!map[c.replace(/[$\d]/g, '')];
  ss.getSheets().forEach((t) => {
    const name = t.getName();
    if (name === BACKUP || name === SHEET || t.getLastRow() === 0) return;
    const rg = t.getDataRange();
    const fs = rg.getFormulas();
    let changed = false;
    const out = fs.map((row) => row.map((f) => {
      if (!f || f.indexOf(BACKUP) < 0) return f;
      const g = f.replace(ref, (m, a, b) => (known(a) && (!b || known(b)) ? 'Reviews!' + cell(a) + (b ? ':' + cell(b) : '') : m));
      if (g !== f) changed = true;
      return g;
    }));
    if (!changed) return;
    // Write back only the cells that had formulas, so values stay values.
    out.forEach((row, r) => row.forEach((f, c) => { if (f && f !== fs[r][c]) t.getRange(r + 1, c + 1).setFormula(f); }));
  });
}

function styleReviews_(sh) {
  sh.setFrozenRows(1);
  sh.setFrozenColumns(0);
  const all = sh.getRange(1, 1, sh.getMaxRows(), HEADERS.length);
  all.setFontFamily('Arial').setFontSize(10).setVerticalAlignment('top');
  sh.getRange(1, 1, 1, HEADERS.length).setBackground(C.navy).setFontColor(C.navyText).setFontWeight('bold')
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 32);

  // Widths: ID, date, month, brand, market, stars, title, text, parent, child, product, flags..., link, first seen
  const widths = [125, 90, 70, 75, 85, 50, 200, 420, 105, 105, 240, 60, 50, 55, 50, 60, 50, 110, 85];
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
  sh.getRange('S:S').setNumberFormat('yyyy-mm-dd');
  sh.getRange('C:C').setNumberFormat('@');
  sh.getRange('C:F').setHorizontalAlignment('center');
  sh.getRange('L:Q').setHorizontalAlignment('center');
  sh.getRange('H:H').setWrap(true);
  sh.getRange('G:G').setWrap(true);
  sh.getRange('K:K').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sh.getRange('R:R').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  // Stars: 1-2 red, 3 yellow, 4-5 green.
  const stars = sh.getRange('F2:F');
  const rules = sh.getConditionalFormatRules().filter((r) =>
    !r.getRanges().some((g) => g.getA1Notation().indexOf('F2') === 0));
  rules.push(
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThanOrEqualTo(2).setBackground(C.red).setRanges([stars]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(3).setBackground(C.yellow).setRanges([stars]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(4).setBackground(C.green).setRanges([stars]).build());
  sh.setConditionalFormatRules(rules);

  fitFilter_(sh);
  sh.getBandings().forEach((b) => b.remove());
}

function stampUpdated_(ss) {
  const m = ss.getSheetByName('Monthly');
  if (!m) return;
  const tz = ss.getSpreadsheetTimeZone();
  m.getRange('A2').setValue('Updated ' + Utilities.formatDate(new Date(), tz, 'EEE d MMM yyyy, h:mm a') +
    '. Counted by review date. Amazon only shows the last 90 days, so each month stays as it was collected.');
}

// ---------------------------------------------------------------- Monthly tab

// Months always run across the top (oldest on the left, newest on the right,
// then a "Last 12 months" total). Each row is one number. All formulas, so
// the tab updates by itself when Reviews changes.
//   1. All brands and marketplaces, with a chart under it
//   2. Lifepro, with a row per marketplace
//   3. Explore: pick a Brand and a Marketplace from the dropdowns
// Columns: A = label, B..M = the 12 months, N = Last 12 months.
const M_FIRST = 2;                    // column B
const M_TOTAL = M_FIRST + MONTHS;     // column N
const STAR_ROWS = [
  { label: 'Reviews', kind: 'n' }, { label: '1-2 star', kind: 'low' }, { label: '% 1-2 star', kind: 'pct' },
  { label: 'Avg stars', kind: 'avg' },
  { label: '1 star', kind: 'star', k: 1 }, { label: '2 star', kind: 'star', k: 2 }, { label: '3 star', kind: 'star', k: 3 },
  { label: '4 star', kind: 'star', k: 4 }, { label: '5 star', kind: 'star', k: 5 },
];
// Fixed layout (row numbers).
const T1 = 4;                                   // title; header row 5; rows 6..14
const CHART_ROW = T1 + 2 + STAR_ROWS.length + 1; // 15
const T2 = CHART_ROW + 18;                       // Lifepro
const T2_ROWS = STAR_ROWS.slice(0, 4).concat(MARKETS.map((k) => ({ label: k + ' reviews', kind: 'market', market: k })));
const T3 = T2 + 2 + T2_ROWS.length + 1;          // Explore title; picker row T3+1; header T3+2

function buildMonthly_(ss) {
  let m = ss.getSheetByName('Monthly');
  let keep = { brand: 'All', market: 'All' };
  if (m) {
    const at = m.createTextFinder('Brand:').matchEntireCell(true).findNext();
    if (at) keep = { brand: m.getRange(at.getRow(), 2).getValue() || 'All', market: m.getRange(at.getRow(), 4).getValue() || 'All' };
    ss.deleteSheet(m);
  }
  m = ss.insertSheet('Monthly', 0);
  m.setHiddenGridlines(true);
  m.getRange(1, 1, m.getMaxRows(), m.getMaxColumns()).setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  m.setColumnWidth(1, 120);
  for (let c = M_FIRST; c < M_TOTAL; c++) m.setColumnWidth(c, 68);
  m.setColumnWidth(M_TOTAL, 90);

  m.getRange('A1').setValue('Amazon reviews by month').setFontSize(18).setFontWeight('bold').setFontColor(C.navy);
  m.setRowHeight(1, 36);
  m.getRange('A2').setFontColor(C.muted).setFontStyle('italic');

  // 1. Global
  table_(m, T1, '1. All brands, all marketplaces', { brand: null, market: null }, STAR_ROWS);
  chart_(m);
  // 2. Lifepro by marketplace
  table_(m, T2, '2. Lifepro', { brand: '"Lifepro"', market: null }, T2_ROWS);
  // 3. Explore
  const pr = T3 + 1;
  m.getRange(pr, 1).setValue('Brand:').setFontWeight('bold').setHorizontalAlignment('right');
  m.getRange(pr, 3).setValue('Marketplace:').setFontWeight('bold').setHorizontalAlignment('right');
  const pick = (col, list, value) => {
    const r = m.getRange(pr, col);
    r.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['All'].concat(list), true)
      .setAllowInvalid(false).build());
    r.setValue(value).setBackground(C.yellow).setFontWeight('bold').setHorizontalAlignment('center')
      .setBorder(true, true, true, true, false, false, C.line, SpreadsheetApp.BorderStyle.SOLID);
  };
  pick(2, BRANDS, keep.brand);
  pick(4, MARKETS, keep.market);
  m.getRange(pr, 5).setValue('(pick from the yellow boxes)').setFontColor(C.muted).setFontStyle('italic');
  table_(m, T3, '3. Explore', { brand: 'IF($B$' + pr + '="All","*",$B$' + pr + ')',
    market: 'IF($D$' + pr + '="All","*",$D$' + pr + ')' }, STAR_ROWS, T3 + 2);

}

// Builds one table. top = row of the section title; the header row (months)
// is top + 1 unless headerRow is given. filter.brand / .market are formula
// pieces (or null for any). spec = one entry per row.
function table_(m, top, title, filter, spec, headerRow) {
  const hr = headerRow || top + 1;
  const first = hr + 1;
  const n = spec.length;
  const width = 1 + MONTHS + 1;
  const L = colLetter_;
  m.getRange(top, 1).setValue(title).setFontSize(13).setFontWeight('bold').setFontColor(C.navy);
  m.setRowHeight(top, 28);

  const rowOf = {};
  spec.forEach((s, i) => { if (!rowOf[s.kind]) rowOf[s.kind] = first + i; });
  const S = 'Reviews!$' + COL.stars + ':$' + COL.stars;
  const crit = (c) => {
    let s = 'Reviews!$' + COL.month + ':$' + COL.month + ',TEXT(' + L(c) + '$' + hr + ',"yyyy-mm")';
    if (filter.brand) s += ',Reviews!$' + COL.brand + ':$' + COL.brand + ',' + filter.brand;
    if (filter.market) s += ',Reviews!$' + COL.market + ':$' + COL.market + ',' + filter.market;
    return s;
  };

  // Header: Month, then the 12 months oldest to newest, then the total.
  const head = ['Month'];
  for (let i = 0; i < MONTHS; i++) head.push('=EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),1),-' + (MONTHS - 1 - i) + ')');
  head.push('Last 12 months');

  const body = spec.map((s, i) => {
    const r = first + i;
    const row = [s.label];
    for (let c = M_FIRST; c < M_TOTAL; c++) {
      const X = L(c);
      if (s.kind === 'n') row.push('=COUNTIFS(' + crit(c) + ')');
      else if (s.kind === 'low') row.push('=COUNTIFS(' + crit(c) + ',' + S + ',"<=2")');
      else if (s.kind === 'pct') row.push('=IF(' + X + rowOf.n + '=0,"",' + X + rowOf.low + '/' + X + rowOf.n + ')');
      else if (s.kind === 'avg') row.push('=IFERROR(AVERAGEIFS(' + S + ',' + crit(c) + '),"")');
      else if (s.kind === 'star') row.push('=COUNTIFS(' + crit(c) + ',' + S + ',' + s.k + ')');
      else if (s.kind === 'market') row.push('=COUNTIFS(' + crit(c) + ',Reviews!$' + COL.market + ':$' + COL.market + ',"' + s.market + '")');
    }
    const T = L(M_TOTAL), A = L(M_FIRST), Z = L(M_TOTAL - 1);
    if (s.kind === 'pct') row.push('=IF(' + T + rowOf.n + '=0,"",' + T + rowOf.low + '/' + T + rowOf.n + ')');
    else if (s.kind === 'avg') row.push('=IFERROR(SUM(ARRAYFORMULA(' + A + rowOf.n + ':' + Z + rowOf.n + '*IF(' + A + r + ':' + Z + r +
      '="",0,' + A + r + ':' + Z + r + ')))/' + T + rowOf.n + ',"")');
    else row.push('=SUM(' + A + r + ':' + Z + r + ')');
    return row;
  });

  m.getRange(hr, 1, 1, width).setFormulas([head]).setBackground(C.navy).setFontColor(C.navyText)
    .setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  m.getRange(hr, 1).setHorizontalAlignment('left');
  m.getRange(hr, M_FIRST, 1, MONTHS).setNumberFormat('mmm yy');
  m.setRowHeight(hr, 30);
  m.getRange(first, 1, n, width).setFormulas(body);

  m.getRange(first, 1, n, 1).setFontWeight('bold').setHorizontalAlignment('left');
  m.getRange(first, M_FIRST, n, width - 1).setHorizontalAlignment('center').setNumberFormat('#,##0;-#,##0;"-"');
  m.getRange(first, M_TOTAL, n, 1).setFontWeight('bold').setBackground(C.total);
  spec.forEach((s, i) => {
    const r = m.getRange(first + i, M_FIRST, 1, width - 1);
    if (s.kind === 'pct') r.setNumberFormat('0.0%');
    if (s.kind === 'avg') r.setNumberFormat('0.00');
    if (s.kind === 'n') r.setFontSize(12).setFontWeight('bold');
    if (s.kind === 'star' || s.kind === 'market') r.setFontColor('#333333');
  });

  // Zebra rows and a frame.
  for (let i = 0; i < n; i += 2) m.getRange(first + i, 1, 1, width - 1).setBackground(C.light);
  m.getRange(hr, 1, n + 1, width)
    .setBorder(true, true, true, true, true, null, C.line, SpreadsheetApp.BorderStyle.SOLID);

  // Colors on average stars and % 1-2 star.
  const rules = m.getConditionalFormatRules();
  if (rowOf.avg) rules.push(SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue('#E67C73', SpreadsheetApp.InterpolationType.NUMBER, '3.5')
    .setGradientMidpointWithValue('#FFF2CC', SpreadsheetApp.InterpolationType.NUMBER, '4.2')
    .setGradientMaxpointWithValue('#57BB8A', SpreadsheetApp.InterpolationType.NUMBER, '4.8')
    .setRanges([m.getRange(rowOf.avg, M_FIRST, 1, MONTHS + 1)]).build());
  if (rowOf.pct) {
    const pct = m.getRange(rowOf.pct, M_FIRST, 1, MONTHS + 1);
    rules.push(
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(0.15).setBackground(C.red)
        .setFontColor('#990000').setRanges([pct]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0.000001, 0.08).setBackground(C.green).setRanges([pct]).build());
  }
  m.setConditionalFormatRules(rules);
}

// Reviews per month (bars) and % 1-2 star (line), from table 1, under it.
// Months on the horizontal axis, oldest to newest, same as the table.
function chart_(m) {
  m.getCharts().forEach((c) => m.removeChart(c));
  const hr = T1 + 1;
  const months = (r) => m.getRange(r, 1, 1, 1 + MONTHS); // label + 12 months, no total
  const chart = m.newChart().asComboChart()
    .addRange(months(hr))
    .addRange(months(hr + 1))   // Reviews
    .addRange(months(hr + 3))   // % 1-2 star
    .setTransposeRowsAndColumns(true)
    .setNumHeaders(1)
    .setOption('title', 'Reviews per month, all brands')
    .setOption('hAxis.format', 'MMM yy')
    .setOption('legend.position', 'bottom')
    .setOption('seriesType', 'bars')
    .setOption('series', {
      0: { type: 'bars', color: C.navy, targetAxisIndex: 0 },
      1: { type: 'line', color: '#CC0000', targetAxisIndex: 1, lineWidth: 3, pointSize: 5 },
    })
    .setOption('vAxes', { 0: { title: 'Reviews' }, 1: { title: '% 1-2 star', format: 'percent' } })
    .setOption('width', 940).setOption('height', 330)
    .setPosition(CHART_ROW + 1, 1, 0, 0)
    .build();
  m.insertChart(chart);
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------------------------------------------------------- By product tab

// One row per Parent ASIN + Brand + Marketplace. Rebuilt after every upload.
// The months run across (oldest to newest, reviews per month), then totals.
function buildByProduct_(ss) {
  const rv = ss.getSheetByName(SHEET);
  const last = rv.getLastRow();
  const data = last > 1 ? rv.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
  const H = {};
  HEADERS.forEach((h, i) => { H[h] = i; });
  const cutoff = new Date(Date.now() - 30 * 864e5);
  const tz = ss.getSpreadsheetTimeZone();

  // The 12 month keys, oldest first ("2025-12" ... "2026-11").
  const now = new Date();
  const months = [];
  for (let i = MONTHS - 1; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const keys = months.map((d) => Utilities.formatDate(d, tz, 'yyyy-MM'));
  const keyIndex = new Map(keys.map((k, i) => [k, i]));

  const groups = new Map();
  for (const r of data) {
    const key = [r[H['Parent ASIN']], r[H['Brand']], r[H['Marketplace']]].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { asin: r[H['Parent ASIN']], brand: r[H['Brand']], market: r[H['Marketplace']], product: '',
        newest: null, n: 0, sum: 0, low: 0, recent: 0, byMonth: keys.map(() => 0) };
      groups.set(key, g);
    }
    const d = r[H['Review date']] instanceof Date ? r[H['Review date']] : new Date(r[H['Review date']]);
    const stars = Number(r[H['Stars']]) || 0;
    g.n++; g.sum += stars; if (stars && stars <= 2) g.low++;
    if (d >= cutoff) g.recent++;
    const mv = r[H['Month']]; // usually the text "2026-11"; Sheets may have turned it into a date
    const mi = keyIndex.get(mv instanceof Date ? Utilities.formatDate(mv, tz, 'yyyy-MM') : String(mv).slice(0, 7));
    if (mi !== undefined) g.byMonth[mi]++;
    if (!g.newest || d > g.newest) { g.newest = d; g.product = r[H['Product']]; }
  }
  const rows = [...groups.values()].sort((a, b) => b.n - a.n).map((g) =>
    [g.asin, g.product, g.brand, g.market].concat(g.byMonth,
      [g.n, g.recent, g.n ? g.sum / g.n : '', g.low, g.n ? g.low / g.n : '', g.newest]));

  let p = ss.getSheetByName('By product');
  if (p) { const f = p.getFilter(); if (f) f.remove(); p.clear(); p.clearConditionalFormatRules(); }
  else p = ss.insertSheet('By product');
  const heads = ['Parent ASIN', 'Product', 'Brand', 'Marketplace']
    .concat(months.map((d) => Utilities.formatDate(d, tz, 'MMM yy')),
      ['All reviews', 'Last 30 days', 'Avg stars', '1-2 star', '% 1-2 star', 'Newest review']);
  const W = heads.length;
  const M0 = 5;                // first month column (E)
  const T0 = M0 + MONTHS;      // "All reviews" column
  if (p.getMaxColumns() < W) p.insertColumnsAfter(p.getMaxColumns(), W - p.getMaxColumns());
  p.getRange(1, 1, 1, W).setValues([heads]).setBackground(C.navy).setFontColor(C.navyText)
    .setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  p.setRowHeight(1, 32);
  p.setFrozenRows(1);
  p.setFrozenColumns(2);
  if (rows.length) {
    if (rows.length + 1 > p.getMaxRows()) p.insertRowsAfter(p.getMaxRows(), rows.length + 1 - p.getMaxRows());
    p.getRange(2, 1, rows.length, W).setValues(rows);
    p.getRange(2, 3, rows.length, W - 2).setHorizontalAlignment('center');
    p.getRange(2, M0, rows.length, MONTHS + 2).setNumberFormat('#,##0;-#,##0;"-"');
    p.getRange(2, M0, rows.length, MONTHS).setFontColor('#333333');
    p.getRange(2, T0, rows.length, 1).setFontWeight('bold').setBackground(C.total);
    p.getRange(2, T0 + 2, rows.length, 1).setNumberFormat('0.00');
    p.getRange(2, T0 + 3, rows.length, 1).setNumberFormat('#,##0;-#,##0;"-"');
    p.getRange(2, T0 + 4, rows.length, 1).setNumberFormat('0.0%');
    p.getRange(2, T0 + 5, rows.length, 1).setNumberFormat('yyyy-mm-dd');
    const avg = p.getRange(2, T0 + 2, rows.length, 1);
    const pct = p.getRange(2, T0 + 4, rows.length, 1);
    p.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().setGradientMinpointWithValue('#E67C73', SpreadsheetApp.InterpolationType.NUMBER, '3.5')
        .setGradientMidpointWithValue('#FFF2CC', SpreadsheetApp.InterpolationType.NUMBER, '4.2')
        .setGradientMaxpointWithValue('#57BB8A', SpreadsheetApp.InterpolationType.NUMBER, '4.8').setRanges([avg]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(0.15).setBackground(C.red)
        .setFontColor('#990000').setRanges([pct]).build(),
    ]);
    p.getRange(1, 1, rows.length + 1, W).createFilter();
  }
  [110, 300, 70, 85].forEach((w, i) => p.setColumnWidth(i + 1, w));
  for (let c = M0; c < T0; c++) p.setColumnWidth(c, 58);
  [80, 75, 70, 65, 75, 95].forEach((w, i) => p.setColumnWidth(T0 + i, w));
  p.getRange(1, 1, p.getMaxRows(), W).setFontFamily('Arial').setFontSize(10);
  p.getRange('B:B').setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
}

// ---------------------------------------------------------------- missed-run check
// Runs on Google's side, so it works even if the Mac is dead.

// setup() runs this. It schedules checkMissedRun for Monday and Tuesday ~9am.
function setupMissedRunCheck() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'checkMissedRun')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  [ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.TUESDAY].forEach((d) =>
    ScriptApp.newTrigger('checkMissedRun').timeBased().onWeekDay(d).atHour(9).everyWeeks(1).create());
  MailApp.sendEmail(EMAIL_TO, 'Amazon reviews: missed-run check is on',
    'Every Monday and Tuesday around 9am Google will check that the Mac sent its 6am pull result. ' +
    'If it did not, you will get an email.');
}

function checkMissedRun() {
  const last = PropertiesService.getScriptProperties().getProperty('lastPullAt');
  const hours = last ? (Date.now() - new Date(last).getTime()) / 36e5 : Infinity;
  if (hours > 12) {
    const day = Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'EEEE');
    MailApp.sendEmail(EMAIL_TO, 'Amazon reviews: ' + day + ' pull DID NOT RUN',
      'The Mac did not report a pull this morning' +
      (last ? ' (last report: ' + last.slice(0, 16).replace('T', ' ') + ' UTC).' : '.') + '\n\n' +
      'Usually: the Mac was off, asleep without power, or the lid was closed.\n\n' +
      'Fix: open the Mac, plug it in, then in Terminal:\n' +
      '  cd sellercentral-scraper\n  npm run pull');
  }
}
