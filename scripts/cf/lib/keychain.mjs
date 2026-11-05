// macOS `security find-generic-password -w` prints a secret that contains a newline (e.g. an age identity file) as HEX.
// Decode that, but only when the decoded text looks like the expected secret, so a genuine hex token is left alone.
import { execFileSync } from 'node:child_process';

const looksLikeSecret = (text, expect) => (expect ? expect.test(text) : text.includes('\n'));

export function decodeKeychainOutput(raw, expect) {
  const s = String(raw).trim();
  if (s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    const decoded = Buffer.from(s, 'hex').toString('utf8');
    if (looksLikeSecret(decoded, expect)) return decoded.trim();
  }
  return s;
}

/** @param {string} service  @param {{expect?: RegExp, account?: string}} [opts] */
export function readKeychainSecret(service, opts = {}) {
  const args = ['find-generic-password', '-s', service];
  if (opts.account) args.push('-a', opts.account);
  args.push('-w');
  return decodeKeychainOutput(execFileSync('security', args, { encoding: 'utf8' }), opts.expect);
}

// CLI: `node scripts/cf/lib/keychain.mjs <service> [--age]` prints the decoded secret (use instead of `security ... -w`).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [service, flag] = process.argv.slice(2);
  if (!service) throw new Error('usage: keychain.mjs <service> [--age]');
  process.stdout.write(
    readKeychainSecret(service, flag === '--age' ? { expect: /^AGE-SECRET-KEY-1|\n/ } : {}) + '\n'
  );
}
