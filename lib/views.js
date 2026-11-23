// The list of views (store + marketplace) to pull, from views.json.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Amazon site per marketplace code, for review links in the sheet and email.
export const AMAZON_SITE = {
  US: 'amazon.com', CA: 'amazon.ca', MX: 'amazon.com.mx', BR: 'amazon.com.br',
  UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it', ES: 'amazon.es',
  NL: 'amazon.nl', BE: 'amazon.com.be', SE: 'amazon.se', PL: 'amazon.pl',
  AE: 'amazon.ae', SA: 'amazon.sa',
};

export function reviewLink(reviewId, code) {
  return `https://www.${AMAZON_SITE[code] || 'amazon.com'}/gp/customer-reviews/${reviewId}`;
}

export const viewKey = (v) => `${v.store}|${v.code}`;
export const viewName = (v) => `${v.brand} ${v.code}`;

export function loadViews(file = process.env.VIEWS_FILE || path.join(config.root, 'views.json')) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const v of data.views) {
    for (const k of ['store', 'marketplace', 'code', 'brand', 'day']) {
      if (!v[k]) throw new Error(`views.json: a view is missing "${k}": ${JSON.stringify(v)}`);
    }
    v.enabled = v.enabled !== false;
  }
  return data;
}

// Which views this run pulls.
//   --day=monday | --day=tuesday   (default: today's weekday)
//   --view="Joyberri LLC/US"       (one view; can repeat; works for disabled ones too)
//   --all                          (every enabled view)
export function pickViews(data, argv = process.argv.slice(2), today = new Date()) {
  const picked = argv.filter((a) => a.startsWith('--view=')).map((a) => a.slice(7));
  if (picked.length) {
    return picked.map((p) => {
      const [store, code] = p.split('/');
      const v = data.views.find((x) => x.store.toLowerCase() === store.trim().toLowerCase() &&
        x.code.toLowerCase() === (code || '').trim().toLowerCase());
      if (!v) throw new Error(`No view "${p}" in views.json. Use "Store name/CODE", e.g. "Joyberri LLC/US".`);
      return v;
    });
  }
  if (argv.includes('--all')) return data.views.filter((v) => v.enabled);
  const dayArg = argv.find((a) => a.startsWith('--day='));
  const day = (dayArg ? dayArg.slice(6) : today.toLocaleDateString('en-US', { weekday: 'long' })).toLowerCase();
  return data.views.filter((v) => v.enabled && v.day === day);
}

// Views for this day that are turned off, so the email can list them.
export function waitingViews(data, day) {
  return data.views.filter((v) => !v.enabled && v.day === day);
}
