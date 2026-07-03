import { describe, it, expect, vi, beforeEach } from 'vitest';

// dns.lookup is mocked so host-based cases are deterministic (no real network).
vi.mock('dns', () => {
  const lookup = vi.fn();
  return { promises: { lookup } };
});

import { promises as dns } from 'dns';
import { assertPublicHttpUrl } from '../../apps/api/src/lib/safe-fetch';

const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

describe('assertPublicHttpUrl (SSRF guard)', () => {
  beforeEach(() => mockLookup.mockReset());

  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow(/SSRF_BLOCKED/);
    await expect(assertPublicHttpUrl('ftp://host/x')).rejects.toThrow(/SSRF_BLOCKED/);
    await expect(assertPublicHttpUrl('gopher://host')).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it('rejects a malformed URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/SSRF_BLOCKED/);
  });

  it.each([
    'http://127.0.0.1/x', // loopback
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/x', // private
    'http://172.16.0.1/x', // private
    'http://192.168.1.1/x', // private
    'http://0.0.0.0/x', // unspecified
    'http://100.64.0.1/x', // CGNAT
    'http://[::1]/x', // IPv6 loopback
    'http://[::ffff:127.0.0.1]/x', // IPv4-mapped loopback
  ])('rejects private/loopback IP literal %s', async url => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow(/SSRF_BLOCKED/);
    expect(mockLookup).not.toHaveBeenCalled(); // IP literal → no DNS needed
  });

  it('allows a public IP literal', async () => {
    await expect(assertPublicHttpUrl('https://8.8.8.8/img.png')).resolves.toBeInstanceOf(URL);
  });

  it('blocks a host that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(assertPublicHttpUrl('https://evil.example.com/x.png')).rejects.toThrow(
      /SSRF_BLOCKED/
    );
  });

  it('blocks when ANY of several resolved addresses is private', async () => {
    mockLookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(assertPublicHttpUrl('https://rebind.example.com/x.png')).rejects.toThrow(
      /SSRF_BLOCKED/
    );
  });

  it('allows a host that resolves only to public addresses', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHttpUrl('https://cdn.example.com/x.png')).resolves.toBeInstanceOf(URL);
  });

  it('blocks a host that resolves to nothing', async () => {
    mockLookup.mockResolvedValue([]);
    await expect(assertPublicHttpUrl('https://nope.example.com/x.png')).rejects.toThrow(
      /SSRF_BLOCKED/
    );
  });
});
