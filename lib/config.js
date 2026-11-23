// All settings in one place. Override any of them with environment variables.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const config = {
  root: ROOT,

  // The reviews page (not in the Seller Central menus, only by this link).
  reviewsUrl:
    process.env.REVIEWS_URL ||
    'https://sellercentral.amazon.com/brand-customer-reviews/?includeDone=true&pageSize=50',

  // Saved Chrome profile with the signed-in session. Never share or commit.
  profileDir: process.env.PROFILE_DIR || path.join(ROOT, '.browser-profile'),

  // Vendor Central report (Custom analytics dashboard) and its own saved profile.
  vcUrl: process.env.VC_URL ||
    'https://vendorcentral.amazon.com/custom-analytics/dashboard/01a20521-2769-7885-be72-fe3bc0a0d7ee',
  vcProfileDir: process.env.VC_PROFILE_DIR || path.join(ROOT, '.browser-profile-vc'),

  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'reviews.db'),
  exportDir: path.join(ROOT, 'exports'),

  // Use the installed Google Chrome, not Playwright's bundled Chromium.
  browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
  headless: process.env.HEADLESS === '1',

  // Pause like a person reading: seconds between page clicks (random in range).
  minDelaySec: Number(process.env.MIN_DELAY_SEC || 4),
  maxDelaySec: Number(process.env.MAX_DELAY_SEC || 9),

  // The page has at most 20 pages. Hard stop in case something loops.
  maxPages: Number(process.env.MAX_PAGES || 22),
};
