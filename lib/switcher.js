// Switches the Seller Central top-bar selector (store + marketplace) by
// clicking it like a person. How the real selector works (checked 2026-11-18):
//   - Header: .dropdown-account-switcher-header, shows
//     .dropdown-account-switcher-header-label-global   (store, "LIFEPRO OUTLET")
//     .dropdown-account-switcher-header-label-regional (marketplace, "United States")
//   - Click the header: a list opens. Stores are .dropdown-account-switcher-list-item
//     with title="<store>". Marketplaces are the items with the extra class
//     ...-list-item-indented right after their store.
//   - A store's arrow icon (.dropdown-account-switcher-list-item-icon) only
//     expands or collapses it. Nothing switches until you click a marketplace.
//   - Clicking a marketplace switches (for every open Seller Central tab) and
//     sends the page to Seller Central home. So afterwards we open the
//     reviews page again and check the header.
//   - Marketplaces not ready show "(pending registration)" in the title.
//   - Europe (e.g. United Kingdom) sends you to sellercentral.amazon.co.uk,
//     which needs its own sign-in.
import { config } from './config.js';
import { needsLogin, sleep } from './browser.js';

const HEADER = '.dropdown-account-switcher-header';
const STORE_LABEL = '.dropdown-account-switcher-header-label-global';
const MARKET_LABEL = '.dropdown-account-switcher-header-label-regional';

export class SwitchError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // kind: not_available | other_site | login_needed | failed
}

export async function currentView(page) {
  const read = (sel) => page.locator(sel).first().textContent({ timeout: 15000 }).then((t) => t.trim()).catch(() => null);
  return { store: await read(STORE_LABEL), marketplace: await read(MARKET_LABEL) };
}

const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

async function humanClick(loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(300 + Math.random() * 600);
  await loc.hover();
  await sleep(150 + Math.random() * 300);
  await loc.click();
}

// Makes the top bar show store + marketplace, switching if needed.
// Leaves the page wherever Amazon sent it (home after a switch); the caller
// then opens the reviews page and calls checkView(). Throws SwitchError.
export async function selectView(page, { store, marketplace }) {
  const reviewsHost = new URL(config.reviewsUrl).host;

  if (new URL(page.url()).host !== reviewsHost || page.url() === 'about:blank') {
    await page.goto(config.reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  }
  if (await needsLogin(page)) throw new SwitchError('Signed out. Run: npm run login', 'login_needed');

  const now = await currentView(page);
  if (same(now.store, store) && same(now.marketplace, marketplace)) return { switched: false };

  // 1. Open the list (unless it is already open).
  const firstItem = page.locator('.dropdown-account-switcher-list-item').first();
  if (!(await firstItem.isVisible().catch(() => false))) await humanClick(page.locator(HEADER).first());
  await firstItem.waitFor({ timeout: 15000 });
  await sleep(500 + Math.random() * 700);

  // 2. Expand the store if its marketplaces aren't showing.
  const storeItem = page.locator(`.dropdown-account-switcher-list-item:not(.dropdown-account-switcher-list-item-indented)[title="${store}"]`).first();
  if ((await storeItem.count()) === 0) throw new SwitchError(`Store "${store}" is not in the selector`, 'not_available');
  const expanded = await storeItem.locator('.dropdown-account-switcher-list-item-icon-expanded').count();
  if (!expanded) {
    await humanClick(storeItem.locator('.dropdown-account-switcher-list-item-icon').first());
    await sleep(800 + Math.random() * 700);
  }

  // 3. Find the marketplace under that store (the indented items right after it).
  const found = await page.evaluate(({ store, marketplace }) => {
    document.querySelectorAll('[data-scraper-pick]').forEach((e) => e.removeAttribute('data-scraper-pick'));
    const items = [...document.querySelectorAll('.dropdown-account-switcher-list-item')];
    const i = items.findIndex((e) => !e.classList.contains('dropdown-account-switcher-list-item-indented') && e.title === store);
    const children = [];
    for (let k = i + 1; k < items.length && items[k].classList.contains('dropdown-account-switcher-list-item-indented'); k++) children.push(items[k]);
    const exact = children.find((e) => e.title === marketplace);
    if (exact) { exact.setAttribute('data-scraper-pick', '1'); return 'ok'; }
    const pending = children.find((e) => e.title.startsWith(marketplace + ' ('));
    return pending ? pending.title : 'missing';
  }, { store, marketplace });
  if (found !== 'ok') {
    // Close the list again, like a person would.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
    if (await firstItem.isVisible().catch(() => false)) await humanClick(page.locator(HEADER).first()).catch(() => {});
    throw new SwitchError(found === 'missing' ? `${store} does not sell in ${marketplace}` : `${store}: ${found}`, 'not_available');
  }

  // 4. Click it. The page goes to Seller Central home.
  const before = page.url();
  await humanClick(page.locator('[data-scraper-pick="1"]').first());
  await page.waitForURL((u) => u.href !== before, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(2500 + Math.random() * 1500);

  if (new URL(page.url()).host !== reviewsHost) {
    throw new SwitchError(`${marketplace} is on another Seller Central site (${new URL(page.url()).host}) that needs its own sign-in`, 'other_site');
  }
  if (await needsLogin(page)) throw new SwitchError('Signed out while switching. Run: npm run login', 'login_needed');

  // 5. The home page has the same top bar: check it.
  await checkView(page, { store, marketplace });
  return { switched: true };
}

// Throws unless the top bar shows store + marketplace.
export async function checkView(page, { store, marketplace }) {
  const now = await currentView(page);
  if (!same(now.store, store) || !same(now.marketplace, marketplace)) {
    throw new SwitchError(`Wrong view: the top bar shows "${now.store} / ${now.marketplace}"`, 'failed');
  }
}
