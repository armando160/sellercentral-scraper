// Fake Seller Central reviews page for testing without Amazon. Copies what
// the real page does (checked 2026-11-18):
//   - same API path, query params and JSON fields
//   - <kat-pagination> with a shadow-DOM › (part="pagination-nav-right",
//     class "end" when disabled), 50 per page, max 20 pages
//   - the top-bar store / marketplace selector (same class names): the arrow
//     icon expands a store, clicking a marketplace switches (cookie) and goes
//     to /home. Foreign marketplaces (UK, Saudi Arabia, Turkey) clicked on
//     localhost go to 127.0.0.1's sign-in page, like the real site sending you
//     to sellercentral.amazon.co.uk. 127.0.0.1 plays "the foreign site": there
//     they switch normally (set SITE_URL_UK/SA/TR to http://127.0.0.1:PORT/...).
// Plus a fake Apps Script endpoint at /sheets that stores rows by Review ID.
//   node test/mock-site.js 8899
// Env: MOCK_TOTAL (Lifepro US reviews, default 130), MOCK_EXTRA (new ones on top),
//      MOCK_LOGGED_OUT=1 (show a sign-in page), MOCK_FAIL="Joyberri LLC|Canada" (that view's data fails),
//      MOCK_FOREIGN_LOGGED_OUT=1 (only 127.0.0.1, the foreign site, is signed out),
//      MOCK_FOREIGN_FLAKY_SEC=N / MOCK_VC_FLAKY_SEC=N (signed out only for the first N seconds),
//      MOCK_SIGNIN_BOUNCE=1 (first visit passes through /ap/signin for 4s, then comes back)
// Vendor Central dashboard at /custom-analytics/dashboard/<id> (same data path,
// fields, header text and Export button as the real one, checked 2026-11-22).
// Env: MOCK_VC_LOGGED_OUT=1, MOCK_VC_PERIOD (period text), MOCK_VC_RATINGS_DATE
//      (YYYY-MM-DD, default 2026-11-19), MOCK_VC_NO_EXPORT=1, MOCK_VC_DROP_COL=RAW_RATING
import http from 'node:http';
import fs from 'node:fs';

// MOCK_FOREIGN_FLAKY_SEC=N / MOCK_VC_FLAKY_SEC=N: a false alarm. The site shows
// the sign-in page for the first N seconds after the mock starts, then is
// signed in again (like 25 Nov 2026 on a shaky connection).
const started = Date.now();
const flaky = (name) => Number(process.env[name]) > 0 && Date.now() - started < Number(process.env[name]) * 1000;

const port = Number(process.argv[2] || 8899);
const TOTAL = Number(process.env.MOCK_TOTAL || 130);
const EXTRA = Number(process.env.MOCK_EXTRA || 0);
const sheet = new Map();

// Stores and their marketplaces, like the real selector. Count = reviews in that view.
const STORES = {
  'High Cloud Sales': { 'United States': 5 },
  'Joyberri LLC': { 'United States': 60, 'Canada': 0, 'Mexico': 2 },
  'LIFEPRO OUTLET': { 'Australia': 0, 'Canada': 12, 'Mexico': 3, 'Saudi Arabia': 4, 'Turkey': 2, 'United Kingdom': 6, 'United States': null },
  'Sunello': { 'Australia (pending registration)': 0, 'Canada': 4, 'United States': 1 },
};
const DEFAULT = 'LIFEPRO OUTLET|United States';
const selOf = (req) => decodeURIComponent((req.headers.cookie || '').match(/(?:^|; )sel=([^;]+)/)?.[1] || DEFAULT);
const viewIndex = (sel) => Object.entries(STORES).flatMap(([s, m]) => Object.keys(m).map((k) => `${s}|${k}`)).indexOf(sel);

function review(i, sel = DEFAULT) {
  const [store, market] = sel.split('|');
  const ts = new Date(Date.UTC(2026, 10, 18) - (i - 900) * 3 * 3600 * 1000).toISOString();
  return {
    asin: ['B0TESTPAR2', 'B0TESTPAR3', 'B0TESTPAR4'][i % 3 === 0 ? 0 : i % 7 === 0 ? 2 : 1], asinThumbnail: 'https://m.media-amazon.com/images/I/x.jpg',
    asinTitle: `${store} product (${market})`, asinTotalReviewCount: 100, asinWeightedStarRating: 4.5,
    brandName: store, childAsin: i % 2 ? 'B0TESTCHL2' : 'B0TESTCHL3',
    reviewAuthorPublicName: 'Reviewer Name', reviewCreatedTimestamp: ts, reviewHasImages: false,
    reviewId: (sel === DEFAULT ? 'R' : `R${viewIndex(sel)}X`) + String(100000000000 + i), reviewIsRepliedTo: false, reviewIsVerifiedPurchase: true,
    reviewIsVideo: false, reviewIsVineReview: i % 10 === 0, reviewMarkedAsDone: false,
    reviewRating: (i % 5) + 1, reviewText: `Body ${i}`, reviewTitle: `Title ${i}`,
  };
}
function all(sel) {
  if (sel === DEFAULT) return Array.from({ length: TOTAL + EXTRA }, (_, i) => review(i - EXTRA + 1000));
  const [store, market] = sel.split('|');
  return Array.from({ length: STORES[store]?.[market] ?? 0 }, (_, i) => review(i + 1000, sel));
}

const header = (sel) => {
  const [store, market] = sel.split('|');
  return `<div class="account-switcher-root"><div class="dropdown-account-switcher-header" role="button" tabindex="0"
  style="display:inline-block;padding:6px;border:1px solid #999;cursor:pointer"><div class="dropdown-account-switcher-header-label">
  <span class="dropdown-account-switcher-header-label-global">${store}</span> |
  <span class="dropdown-account-switcher-header-label-regional">${market}</span></div></div>
  <div id="sw-list" style="display:none"></div></div>
<script>
const STORES = ${JSON.stringify(Object.fromEntries(Object.entries(STORES).map(([k, v]) => [k, Object.keys(v)])))};
const open = new Set([${JSON.stringify(store)}]);
const list = document.getElementById('sw-list');
function render() {
  let h = '<div class="dropdown-account-switcher-list-header">Switch Accounts</div>';
  for (const [s, ms] of Object.entries(STORES)) {
    const ex = open.has(s);
    h += '<div class="dropdown-account-switcher-list-item" title="' + s + '"><span class="dropdown-account-switcher-list-item-icon' +
      (ex ? ' dropdown-account-switcher-list-item-icon-expanded' : '') + '" style="padding:4px;cursor:pointer">' + (ex ? 'v' : '>') +
      '</span><div class="dropdown-account-switcher-list-item-label">' + s + '</div></div>';
    if (ex) for (const m of ms) h += '<div class="dropdown-account-switcher-list-item dropdown-account-switcher-list-item-indented" title="' + m +
      '" data-store="' + s + '" style="padding-left:20px;cursor:pointer"><div class="dropdown-account-switcher-list-item-label">' + m + '</div></div>';
  }
  list.innerHTML = h;
}
document.querySelector('.dropdown-account-switcher-header').onclick = () => {
  list.style.display = list.style.display === 'none' ? 'block' : 'none'; render();
};
list.onclick = (e) => {
  const icon = e.target.closest('.dropdown-account-switcher-list-item-icon');
  if (icon) { const s = icon.parentElement.title; open.has(s) ? open.delete(s) : open.add(s); render(); return; }
  const it = e.target.closest('.dropdown-account-switcher-list-item-indented');
  if (!it) return;
  if (['United Kingdom', 'Saudi Arabia', 'Turkey'].includes(it.title) && location.hostname !== '127.0.0.1') {
    location.href = location.protocol + '//127.0.0.1:' + location.port + '/ap/signin?uk=1'; return;
  }
  document.cookie = 'sel=' + encodeURIComponent(it.dataset.store + '|' + it.title) + '; path=/';
  setTimeout(() => { location.href = '/home?mons_sel_mkid=x'; }, 300);
};
</script>`;
};

const html = (sel) => `<!doctype html><html><body>
${header(sel)}
<h1>Customer Reviews</h1><div id="list" style="height:1500px"></div>
<kat-pagination></kat-pagination>
<script>
customElements.define('kat-pagination', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<nav aria-label="Pagination"><span part="pagination-nav-left" class="nav item end">&lsaquo;</span>' +
      '<span part="pagination-nav-right" class="nav item" style="display:inline-block;padding:8px;cursor:pointer">&rsaquo;</span></nav>';
    root.querySelector('[part="pagination-nav-right"]').onclick = (e) => {
      if (!e.currentTarget.classList.contains('end')) this.dispatchEvent(new Event('next'));
    };
  }
  set last(v) { this.shadowRoot.querySelector('[part="pagination-nav-right"]').classList.toggle('end', v); }
});
let page = 0;
const pag = document.querySelector('kat-pagination');
async function load() {
  const r = await fetch('/brandcustomerreviews/api/reviews?pageId=' + page + '&pageSize=50&sortByType=REVIEW_CREATED_DATE&isAscending=false&includeDone=true').then(r => r.json());
  document.getElementById('list').textContent = r.reviews.map(x => x.reviewId).join(' ');
  pag.last = page + 1 >= r.totalPageCount;
  history.replaceState(null, '', '?includeDone=true&pageNumber=' + (page + 1) + '&pageSize=50');
}
pag.addEventListener('next', () => { page++; load(); });
load();
</script></body></html>`;


// ---- Vendor Central
const VC_ROWS = [
  { ASIN: 'B0TESTCHL1', ITEM_NAME: 'Test Plate Black', PREFERRED_DISPLAY_NAME: 'TestBrand', PARENT_ASIN: 'B0TESTPAR1', COLOR_NAME: 'Black', TOTAL_RATING_COUNT: '1,200', RAW_RATING: '4.60', QUANTITY_SHIPPED: '50', BRAND_NAME: 'TestBrand' },
  { ASIN: 'B0TESTCHL2', ITEM_NAME: 'Test Plate Blue', PREFERRED_DISPLAY_NAME: 'TestBrand', PARENT_ASIN: 'B0TESTPAR1', COLOR_NAME: 'Blue', TOTAL_RATING_COUNT: '1,200', RAW_RATING: '4.60', QUANTITY_SHIPPED: '20', BRAND_NAME: 'TestBrand' },
  { ASIN: 'B0TESTCHL3', ITEM_NAME: 'Test Gun', PREFERRED_DISPLAY_NAME: 'OtherBrand', PARENT_ASIN: 'B0TESTPAR2', COLOR_NAME: 'Gray', TOTAL_RATING_COUNT: '75', RAW_RATING: '4.37', QUANTITY_SHIPPED: '5', BRAND_NAME: 'TestBrand' },
];
// Tables like the real dashboard (MOCK_VC_TILES=1 gives only the first one).
const VC_TILES = [
  { name: 'Reviews & Units', period: 'Month to date: Nov 1, 2026 (Nov) - Nov 19, 2026', range: { fromDate: '20261101', toDate: '20261119', type: 'RECURRINGLY' }, ratings: true },
  { name: 'Ratings, 12 Months', period: 'Last 12 months: Nov 1, 2025 - Oct 31, 2026', range: { fromDate: '20251101', toDate: '20261031', type: 'TRAILINGLY' }, ratings: true, extra: true },
  { name: 'Last Week', period: 'Week of Nov 8, 2026 - Nov 14, 2026', range: { fromDate: '20261108', toDate: '20261114', type: 'WEEKLY' } },
  { name: 'Last Month', period: 'Oct 2026 > Oct 1, 2026 - Oct 31, 2026', range: { fromDate: '20261001', toDate: '20261031', type: 'MONTHLY' } },
];
const vcTiles = () => VC_TILES.slice(0, Number(process.env.MOCK_VC_TILES || 4));
function vcData(body) {
  const [y, m, d] = (process.env.MOCK_VC_RATINGS_DATE || '2026-11-19').split('-').map(Number);
  const units = { year: y, month: m, day: d - 1 };
  const tile = VC_TILES.find((t) => t.range.fromDate === body?.dateRanges?.[0]?.fromDate) || VC_TILES[0];
  // Since 23 Nov 2026 the rating tables have Ordered Units (moved) instead of
  // Shipped Units. MOCK_VC_OLD_LAYOUT=1 gives the layout from before.
  const ids = (tile.ratings
    ? (process.env.MOCK_VC_OLD_LAYOUT
      ? ['ASIN', 'ITEM_NAME', 'TOTAL_RATING_COUNT', 'RAW_RATING', 'PREFERRED_DISPLAY_NAME', 'PARENT_ASIN', 'COLOR_NAME', 'QUANTITY_SHIPPED', 'BRAND_NAME']
      : ['ASIN', 'ITEM_NAME', 'TOTAL_ORDERED_UNITS', 'TOTAL_RATING_COUNT', 'RAW_RATING', 'PREFERRED_DISPLAY_NAME', 'PARENT_ASIN', 'COLOR_NAME', 'BRAND_NAME'])
    : ['ASIN', 'ITEM_NAME', 'PARENT_ASIN', 'TOTAL_ORDERED_UNITS', 'QUANTITY_SHIPPED']).filter((c) => c !== process.env.MOCK_VC_DROP_COL);
  let rows = VC_ROWS.map((r) => Object.fromEntries(Object.entries({ ...r, TOTAL_ORDERED_UNITS: r.QUANTITY_SHIPPED }).filter(([k]) => ids.includes(k))));
  if (tile.extra) rows = rows.concat([Object.fromEntries(Object.entries({ ASIN: 'B0TESTOLD1', ITEM_NAME: 'Old product', PARENT_ASIN: 'B0TESTOLDP', TOTAL_RATING_COUNT: '40', RAW_RATING: '3.90', PREFERRED_DISPLAY_NAME: 'TestBrand', COLOR_NAME: '', QUANTITY_SHIPPED: '3', TOTAL_ORDERED_UNITS: '3', BRAND_NAME: 'TestBrand' }).filter(([k]) => ids.includes(k)))]);
  return { metricsData: {
    metadata: { fromRow: 0, toRow: 5000, sortDirection: 'DESC', sortMetricId: 'QUANTITY_SHIPPED', commonDate: { day: d, month: m, year: y } },
    data: { rowData: rows, totalsData: {} },
    schema: { columns: ids.map((c) => ({ columnId: c, columnLabel: c, dataSetDate: c === 'QUANTITY_SHIPPED' ? units : { year: y, month: m, day: d } })) },
  }, error: null, responseCode: 200 };
}
const vcPage = () => `<!doctype html><html><body>
<nav>Dashboards<br>Amazon Curated<br>View<br>Overall Business Performance</nav>
${vcTiles().map((t, i) => `<div class="tile" style="min-height:900px;border:1px solid #ccc">
<h2>${t.name}</h2>
<div>Data last updated on: 11/19/2026</div>
<div>Time Period(s)</div><div>${i === 0 && process.env.MOCK_VC_PERIOD ? process.env.MOCK_VC_PERIOD : t.period}</div>
<div>Fulfillment channel</div><div>Both (Retail and B2B)</div>
<div>View</div><div>Manufacturing</div>
<div class="sc-export"><button class="sc-export__button" data-testid="btn-export" data-tile="${i}" type="submit">Export</button></div>
<table id="t${i}"><tr><td>loading...</td></tr></table></div>`).join('')}
<script>
const TILES = ${JSON.stringify(vcTiles().map((t) => t.range))};
async function load(i) {
  const r = await fetch('/ca/metricdata/api/v1/metricdata', { method: 'POST', body: JSON.stringify({ dateRanges: [TILES[i]] }) }).then((x) => x.json());
  document.getElementById('t' + i).innerHTML = r.metricsData.data.rowData.map((x) => '<tr><td>' + x.ASIN + '</td></tr>').join('');
}
// The first two tables load at once; lower ones when scrolled into view (like the real page).
setTimeout(() => { load(0); if (TILES.length > 1) load(1); }, 800);
const done = new Set([0, 1]);
const io = new IntersectionObserver((es) => es.forEach((e) => { const i = Number(e.target.id.slice(1)); if (e.isIntersecting && !done.has(i)) { done.add(i); load(i); } }));
TILES.forEach((_, i) => { if (i > 1) io.observe(document.getElementById('t' + i)); });
document.querySelectorAll('[data-testid=btn-export]').forEach((b) => { b.onclick = () => { location.href = '/vc-export?tile=' + b.dataset.tile; }; });
</script></body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };

  if (url.pathname === '/sheets' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const { token, rows, email } = JSON.parse(b);
      if (token !== 'tok-test') return send(200, 'application/json', JSON.stringify({ ok: false, error: 'bad token' }));
      if (email) {
        console.log(`\n=== EMAIL (${email.kind}) ===\nSubject: ${email.subject}\n${email.text}\n=== END ===`);
        if (email.html) fs.writeFileSync(process.env.MOCK_HTML_OUT || '/dev/null', email.html);
        return send(200, 'application/json', JSON.stringify({ ok: true, emailed: true }));
      }
      let inserted = 0, updated = 0;
      for (const r of rows) { sheet.has(r['Review ID']) ? updated++ : inserted++; sheet.set(r['Review ID'], r); }
      send(200, 'application/json', JSON.stringify({ ok: true, inserted, updated }));
    });
    return;
  }
  if (url.pathname === '/sheets-count') return send(200, 'application/json', JSON.stringify({ rows: sheet.size }));

  if (url.pathname.startsWith('/custom-analytics/dashboard/')) {
    if (process.env.MOCK_VC_LOGGED_OUT === '1' || flaky('MOCK_VC_FLAKY_SEC')) {
      // Like Amazon: a visible sign-in form, plus a hidden fake password field.
      return send(200, 'text/html', '<form><input id="ap_email" type="email"><input type="password" style="display:none"></form>');
    }
    return send(200, 'text/html', vcPage());
  }
  if (url.pathname === '/ca/metricdata/api/v1/metricdata') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { let body = {}; try { body = JSON.parse(b); } catch {} send(200, 'application/json', JSON.stringify(vcData(body))); });
    return;
  }
  if (url.pathname === '/vc-export') {
    if (process.env.MOCK_VC_NO_EXPORT === '1') return send(204, 'text/plain', '');
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="metric-data.xlsx"' });
    return res.end(fs.readFileSync(new URL('./fixtures/vc-export.xlsx', import.meta.url)));
  }

  if (process.env.MOCK_LOGGED_OUT === '1') return send(200, 'text/html', '<input id="ap_email" type="email">');
  if ((process.env.MOCK_FOREIGN_LOGGED_OUT === '1' || flaky('MOCK_FOREIGN_FLAKY_SEC')) && (req.headers.host || '').startsWith('127.0.0.1')) {
    return send(200, 'text/html', '<input id="ap_email" type="email">');
  }

  // MOCK_SIGNIN_BOUNCE=1: the first visit passes through /ap/signin for 4 seconds
  // (no form) and comes back by itself, like Amazon re-checking a good session.
  if (url.pathname === '/ap/signin' && url.searchParams.get('bounce')) {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'bounced=1; path=/' });
    return res.end(`<p>One moment...</p><script>setTimeout(() => { location.href = ${JSON.stringify(url.searchParams.get('return'))}; }, 4000)</script>`);
  }
  if (process.env.MOCK_SIGNIN_BOUNCE === '1' && url.pathname.startsWith('/brand-customer-reviews') && !/(^|; )bounced=1/.test(req.headers.cookie || '')) {
    res.writeHead(302, { location: `/ap/signin?bounce=1&return=${encodeURIComponent(url.pathname + url.search)}` });
    return res.end();
  }
  if (url.pathname === '/ap/signin') return send(200, 'text/html', '<input id="ap_email" type="email">');
  if (url.pathname === '/home') return send(200, 'text/html', `<!doctype html><html><body>${header(selOf(req))}<h1>Home</h1></body></html>`);
  if (url.pathname === '/brandcustomerreviews/api/reviews') {
    const sel = selOf(req);
    if (process.env.MOCK_FAIL === sel) return send(500, 'application/json', '{}');
    const p = Number(url.searchParams.get('pageId'));
    const list = all(sel);
    const pages = Math.max(1, Math.min(20, Math.ceil(list.length / 50)));
    if (p >= 20) return send(400, 'application/json', JSON.stringify({ errorMessage: 'bad page' }));
    return send(200, 'application/json', JSON.stringify({
      totalReviewCount: list.length, totalPageCount: pages, pageId: p, pageSize: 50, validMarketplace: true,
      reviews: list.slice(p * 50, p * 50 + 50) }));
  }
  if (url.pathname.startsWith('/brand-customer-reviews')) return send(200, 'text/html', html(selOf(req)));
  send(404, 'text/plain', 'not found');
}).listen(port, () => console.log(`mock on ${port}`));
