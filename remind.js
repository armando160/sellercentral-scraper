// Day-before reminder (Sunday 6pm by the schedule). Checks two things now,
// so you can fix them tonight instead of finding out Monday:
//   1. Is the Mac plugged in?
//   2. Is Seller Central still signed in? (opens the page out of sight)
import { execFileSync } from 'node:child_process';
import { openBrowser, needsLogin, sleep } from './lib/browser.js';
import { notify } from './lib/notify.js';
import { config } from './lib/config.js';

const problems = [];

try {
  const out = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' });
  if (!/AC Power/.test(out)) problems.push(`NOT plugged in (battery ${out.match(/(\d+)%/)?.[1] ?? '?'}%)`);
} catch {}

let signedIn = null;
try {
  const { context, page } = await openBrowser({ headless: true });
  await page.goto(config.reviewsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  signedIn = !(await needsLogin(page));
  await context.close();
} catch {}
if (signedIn === false) problems.push('Seller Central signed out: run "npm run login"');
if (signedIn === null) problems.push("couldn't check Seller Central");

await notify(
  problems.length ? 'Reviews pull tomorrow: fix tonight' : 'Reviews pull tomorrow 6:00am',
  problems.length ? problems.join('. ') + '.' : 'All good: plugged in, signed in. Leave the lid open.');
console.log(problems.length ? problems.join('\n') : 'All good.');
