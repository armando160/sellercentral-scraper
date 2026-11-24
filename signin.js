// The easy sign-in (the "Amazon Sign In" file on the Desktop runs this).
//
// For every Seller Central site the enabled views use (US, UK, Saudi Arabia,
// Turkey...; see "sites" in views.json) and Vendor Central:
//   1. checks out of sight whether the saved session is still signed in;
//   2. if not, opens Chrome on the sign-in page. YOU type the password and
//      code (this script never touches the form). It notices when you are in
//      and closes the window by itself. No Enter, no Terminal commands.
//   3. if a pull failed today because it was signed out, runs it again now.
//
//   npm run signin
import { spawnSync } from 'node:child_process';
import { openBrowser, needsLogin, isSignedOut, sleep } from './lib/browser.js';
import { openDb } from './lib/db.js';
import { takeLock } from './lib/lock.js';
import { config } from './lib/config.js';
import { loadViews, sitesFor } from './lib/views.js';

const views = loadViews();
const SITES = [
  ...sitesFor(views, views.views.filter((v) => v.enabled))
    .map((s) => ({ key: 'sc', name: s.name, url: s.url, profileDir: config.profileDir, region: s.site })),
  { key: 'vc', name: 'Vendor Central', url: config.vcUrl, profileDir: config.vcProfileDir },
];
const say = (s) => console.log(s);

async function signedIn(site, page) {
  if (await needsLogin(page)) return false;
  return new URL(page.url()).host === new URL(site.url).host;
}

async function check(site) {
  const { context, page } = await openBrowser({ headless: true, profileDir: site.profileDir });
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    if (await isSignedOut(page, { url: site.url, tag: site.region || site.key })) return false;
    return await signedIn(site, page);
  } catch { return null; } finally { await context.close().catch(() => {}); }
}

async function signIn(site) {
  const { context, page } = await openBrowser({ headless: false, profileDir: site.profileDir });
  await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  say(`\n  A Chrome window opened for ${site.name}.`);
  say('  Sign in there (password, code). Tick "Keep me signed in" if you see it.');
  say(site.region && site.region !== 'NA'
    ? '  If it asks for an account or marketplace, pick LIFEPRO OUTLET and any marketplace.'
    : '  If it asks for an account or marketplace, pick LIFEPRO / United States.');
  say('  This window closes by itself once you are in. Waiting up to 20 minutes...');
  const until = Date.now() + 20 * 60000;
  let ok = false;
  while (Date.now() < until) {
    await sleep(3000);
    if (page.isClosed()) break;
    if (await signedIn(site, page).catch(() => false)) {
      await sleep(4000); // let the page finish saving the session
      ok = await signedIn(site, page).catch(() => false);
      if (ok) break;
    }
  }
  await context.close().catch(() => {});
  return ok;
}

// Did a pull fail today because it was signed out?
function failedToday(key) {
  const db = openDb();
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const table = key === 'sc' ? 'runs' : 'vc_pulls';
  const last = db.prepare(`SELECT status, started_at FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  db.close();
  return last && last.status === 'login_needed' &&
    new Date(last.started_at).toLocaleDateString('en-CA') === today;
}

const release = await takeLock('Sign-in', { maxWaitMin: 1, log: say });
if (!release) {
  say('\nA pull is running right now. Try again in 10 minutes.');
  process.exit(1);
}

say(`Checking ${SITES.map((s) => s.name).join(', ')}...`);
const rerun = [];
let problems = 0;
for (const site of SITES) {
  const state = await check(site);
  if (state === true) { say(`\n✓ ${site.name}: already signed in.`); continue; }
  if (state === null) say(`\n${site.name}: couldn't check (no internet?). Opening it anyway.`);
  const ok = await signIn(site);
  if (ok) {
    say(`✓ ${site.name}: signed in and saved.`);
    if (failedToday(site.key) && !rerun.some((r) => r.key === site.key)) rerun.push(site);
  } else {
    say(`✗ ${site.name}: not signed in (window closed or 20 minutes passed). Double-click "Amazon Sign In" again.`);
    problems++;
  }
}
release();

for (const site of rerun) {
  say(`\nToday's ${site.key === 'sc' ? 'Seller Central' : site.name} pull failed because it was signed out. Running it now...`);
  spawnSync(process.execPath, [site.key === 'sc' ? 'scrape.js' : 'vc-pull.js'], { cwd: config.root, stdio: 'inherit' });
}
say(problems ? '\nNot everything is signed in (see above).' : '\nAll signed in. You can close this window.');
process.exit(problems ? 1 : 0);
