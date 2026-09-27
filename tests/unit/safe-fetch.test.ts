import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// dns.lookup is mocked so host-based cases are deterministic (no real network).
vi.mock('dns', () => {
  const lookup = vi.fn();
  return { promises: { lookup } };
});

import { promises as dns } from 'dns';
import { assertPublicHttpUrl, safeFetch } from '../../apps/api/src/lib/safe-fetch';

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

/**
 * The assert above only ever sees the FIRST URL. `fetch` defaults to
 * `redirect: 'follow'`, so validating a URL and then handing it to a bare
 * fetch() leaves the whole bypass open: a host that resolves public answers
 * 302 and undici walks to the metadata endpoint for you. safeFetch is the
 * transport that closes it, so every URL below is PUBLIC and only the hop is
 * on trial.
 */
describe('safeFetch (redirects)', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    mockLookup.mockReset();
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  function redirect(location: string, status = 302) {
    return {
      status,
      headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    };
  }
  const ok = { status: 200, headers: { get: () => null } };

  it('never issues the request to a redirect target in a blocked range', async () => {
    fetchSpy.mockResolvedValue(redirect('http://169.254.169.254/latest/meta-data/'));

    await expect(safeFetch('https://cdn.example.com/x.png')).rejects.toThrow(/SSRF_BLOCKED/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-validates every hop, not just the first', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://hop2.example.com/a'))
      .mockResolvedValueOnce(redirect('http://10.0.0.7/a'));

    await expect(safeFetch('https://cdn.example.com/x.png')).rejects.toThrow(/SSRF_BLOCKED/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('passes a public redirect chain through', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://cdn2.example.com/x.png'))
      .mockResolvedValue(ok);

    const res = await safeFetch('https://cdn.example.com/x.png');

    expect(res.status).toBe(200);
    expect(String(fetchSpy.mock.calls[1][0])).toBe('https://cdn2.example.com/x.png');
  });

  it('gives up rather than looping forever', async () => {
    fetchSpy.mockResolvedValue(redirect('https://cdn.example.com/loop'));

    await expect(safeFetch('https://cdn.example.com/x.png')).rejects.toThrow(/too many redirects/);
  });

  it('returns the 3xx itself when there is no Location to follow', async () => {
    fetchSpy.mockResolvedValue({ status: 302, headers: { get: () => null } });

    const res = await safeFetch('https://cdn.example.com/x.png');

    expect(res.status).toBe(302);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('drops credentials when the redirect crosses origins', async () => {
    fetchSpy.mockResolvedValueOnce(redirect('https://other.example.com/x')).mockResolvedValue(ok);

    await safeFetch('https://cdn.example.com/x.png', {
      headers: { Authorization: 'Bearer secret', 'X-Trace': 'keep-me' },
    });

    const hop = new Headers(fetchSpy.mock.calls[1][1].headers);
    expect(hop.get('authorization')).toBeNull();
    expect(hop.get('x-trace')).toBe('keep-me'); // only credentials are dropped
  });

  it('downgrades POST to GET on a 302, as redirect: follow would', async () => {
    fetchSpy.mockResolvedValueOnce(redirect('https://cdn.example.com/x')).mockResolvedValue(ok);

    await safeFetch('https://cdn.example.com/x.png', { method: 'POST', body: '{"a":1}' });

    expect(fetchSpy.mock.calls[1][1].method).toBe('GET');
    expect(fetchSpy.mock.calls[1][1].body).toBeUndefined();
  });

  it('preserves the method and body on a 307', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://cdn.example.com/x', 307))
      .mockResolvedValue(ok);

    await safeFetch('https://cdn.example.com/x.png', { method: 'POST', body: '{"a":1}' });

    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
    expect(fetchSpy.mock.calls[1][1].body).toBe('{"a":1}');
  });

  // audit-followup #1713: an intermediate redirect response is discarded —
  // only the final response is ever returned to the caller. Leaving its
  // body unconsumed holds the underlying connection open until GC.
  it('cancels the response body of every followed redirect hop', async () => {
    const hop1 = redirect('https://cdn2.example.com/x.png');
    fetchSpy.mockResolvedValueOnce(hop1).mockResolvedValueOnce(ok);

    await safeFetch('https://cdn.example.com/x.png');

    expect(hop1.body.cancel).toHaveBeenCalledOnce();
  });

  it('cancels the response body of every hop, including the one that trips the redirect limit', async () => {
    const loopRes = redirect('https://cdn.example.com/loop');
    fetchSpy.mockResolvedValue(loopRes);

    await expect(safeFetch('https://cdn.example.com/x.png')).rejects.toThrow(/too many redirects/);

    // One cancel per fetch call — including the last hop, whose response is
    // discarded right before the loop exits and throws.
    expect(loopRes.body.cancel).toHaveBeenCalledTimes(fetchSpy.mock.calls.length);
  });

  it('does not cancel the final (non-redirect) response — the caller owns that body', async () => {
    fetchSpy
      .mockResolvedValueOnce(redirect('https://cdn2.example.com/x.png'))
      .mockResolvedValue(ok);

    const res = await safeFetch('https://cdn.example.com/x.png');

    expect(res).toBe(ok);
    // `ok` has no `body` mock at all — if safeFetch tried to cancel it,
    // this would throw rather than silently pass.
  });

  it('swallows a cancel() rejection instead of failing the redirect', async () => {
    const hop1 = redirect('https://cdn2.example.com/x.png');
    hop1.body.cancel.mockRejectedValueOnce(new Error('already closed'));
    fetchSpy.mockResolvedValueOnce(hop1).mockResolvedValueOnce(ok);

    await expect(safeFetch('https://cdn.example.com/x.png')).resolves.toBe(ok);
  });
});
