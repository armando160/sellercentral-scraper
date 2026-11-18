// Fake Seller Central reviews page for testing without Amazon. Copies what
// the real page does (checked 2026-11-18):
//   - same API path, query params and JSON fields
//   - <kat-pagination> with a shadow-DOM › (part="pagination-nav-right",
//     class "end" when disabled), 50 per page, max 20 pages
// Plus a fake Apps Script endpoint at /sheets that stores rows by Review ID.
//   node test/mock-site.js 8899
// Env: MOCK_TOTAL (reviews, default 130), MOCK_EXTRA (new ones on top),
//      MOCK_LOGGED_OUT=1 (show a sign-in page)
import http from 'node:http';

const port = Number(process.argv[2] || 8899);
const TOTAL = Number(process.env.MOCK_TOTAL || 130);
const EXTRA = Number(process.env.MOCK_EXTRA || 0);
const sheet = new Map();

function review(i) {
  const ts = new Date(Date.UTC(2026, 10, 18) - i * 3 * 3600 * 1000).toISOString();
  return {
    asin: 'B0TESTPAR2', asinThumbnail: 'https://m.media-amazon.com/images/I/x.jpg',
    asinTitle: 'Example Brand Dumbbells', asinTotalReviewCount: 100, asinWeightedStarRating: 4.5,
    brandName: 'ExampleBrand', childAsin: i % 2 ? 'B0TESTCHL2' : 'B0TESTCHL3',
    reviewAuthorPublicName: 'Reviewer Name', reviewCreatedTimestamp: ts, reviewHasImages: false,
    reviewId: 'R' + String(100000000000 + i), reviewIsRepliedTo: false, reviewIsVerifiedPurchase: true,
    reviewIsVideo: false, reviewIsVineReview: i % 10 === 0, reviewMarkedAsDone: false,
    reviewRating: (i % 5) + 1, reviewText: `Body ${i}`, reviewTitle: `Title ${i}`,
  };
}
const all = () => Array.from({ length: TOTAL + EXTRA }, (_, i) => review(i - EXTRA + 1000));

const html = `<!doctype html><html><body>
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
        return send(200, 'application/json', JSON.stringify({ ok: true, emailed: true }));
      }
      let inserted = 0, updated = 0;
      for (const r of rows) { sheet.has(r['Review ID']) ? updated++ : inserted++; sheet.set(r['Review ID'], r); }
      send(200, 'application/json', JSON.stringify({ ok: true, inserted, updated }));
    });
    return;
  }
  if (url.pathname === '/sheets-count') return send(200, 'application/json', JSON.stringify({ rows: sheet.size }));

  if (process.env.MOCK_LOGGED_OUT === '1') return send(200, 'text/html', '<input id="ap_email" type="email">');

  if (url.pathname === '/brandcustomerreviews/api/reviews') {
    const p = Number(url.searchParams.get('pageId'));
    const list = all();
    const pages = Math.min(20, Math.ceil(list.length / 50));
    if (p >= 20) return send(400, 'application/json', JSON.stringify({ errorMessage: 'bad page' }));
    return send(200, 'application/json', JSON.stringify({
      totalReviewCount: list.length, totalPageCount: pages, pageId: p, pageSize: 50, validMarketplace: true,
      reviews: list.slice(p * 50, p * 50 + 50) }));
  }
  if (url.pathname.startsWith('/brand-customer-reviews')) return send(200, 'text/html', html);
  send(404, 'text/plain', 'not found');
}).listen(port, () => console.log(`mock on ${port}`));
