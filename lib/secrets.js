// Reads secrets from the macOS Keychain (never from files).
// Saved by setup-secrets.sh under the service name below.
import { execFileSync } from 'node:child_process';

export const SERVICE = 'amazon-review-scraper';

export function getSecret(name, { required = true } = {}) {
  // Tests only: read from env vars (SECRET_EMAIL, SECRET_TOTP, ...) instead of Keychain.
  if (process.env.SECRETS_FROM_ENV === '1') {
    const v = process.env[`SECRET_${name.toUpperCase().replace(/-/g, '_')}`];
    if (!v && required) throw new Error(`Test secret ${name} missing`);
    return v || null;
  }
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    if (required) throw new Error(`Keychain item "${name}" missing. Run: ./setup-secrets.sh`);
    return null;
  }
}
