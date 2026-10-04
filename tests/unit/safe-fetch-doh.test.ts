/**
 * The SSRF guard without `dns` / `net` (apps/api/src/lib/safe-fetch.ts): on Workers the host is resolved
 * through DNS over HTTPS and every answer is checked against the private-range blocklist.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  assertPublicHttpUrl,
  resolveViaDoh,
  setHostResolver,
  type HostResolver,
} from '@api/lib/safe-fetch';

const doh = (
  answers: Record<'A' | 'AAAA', Array<{ type: number; data: string }> | Error | { status: number }>
): typeof fetch =>
  (async (url: string) => {
    const type = new URL(url).searchParams.get('type') as 'A' | 'AAAA';
    const a = answers[type];
    if (a instanceof Error) throw a;
    if ('status' in a) return new Response(JSON.stringify({ Status: a.status }), { status: 200 });
    return new Response(JSON.stringify({ Status: 0, Answer: a }), { status: 200 });
  }) as typeof fetch;

describe('resolveViaDoh', () => {
  it('returns the A and AAAA answers, ignoring CNAME records in the chain', async () => {
    const addrs = await resolveViaDoh(
      'cdn.example.com',
      doh({
        A: [
          { type: 5, data: 'edge.example.net.' },
          { type: 1, data: '93.184.216.34' },
        ],
        AAAA: [{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }],
      })
    );
    expect(addrs.map(a => a.address)).toEqual([
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]);
  });

  it('NXDOMAIN is an empty answer, not a failure', async () => {
    expect(
      await resolveViaDoh('nope.invalid', doh({ A: { status: 3 }, AAAA: { status: 3 } }))
    ).toEqual([]);
  });

  it('a failing family is a FAILED lookup: an unchecked family must not slip through', async () => {
    await expect(
      resolveViaDoh(
        'x.example',
        doh({ A: [{ type: 1, data: '93.184.216.34' }], AAAA: new Error('timeout') })
      )
    ).rejects.toThrow('DoH lookup failed');
  });

  it('SERVFAIL (status 2) is a failure too', async () => {
    await expect(
      resolveViaDoh('x.example', doh({ A: { status: 2 }, AAAA: { status: 0 } as never }))
    ).rejects.toThrow();
  });
});

describe('assertPublicHttpUrl through a swapped resolver', () => {
  let prev: HostResolver | undefined;
  afterEach(() => prev && setHostResolver(prev));
  const resolveTo = (...addresses: string[]) =>
    (prev = setHostResolver(async () => addresses.map(address => ({ address }))));

  it('accepts a host that resolves only to public addresses', async () => {
    resolveTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(assertPublicHttpUrl('https://cdn.example.com/a.png')).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['cloud metadata', '169.254.169.254'],
    ['RFC1918', '10.0.0.5'],
    ['CGNAT', '100.64.1.1'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped loopback', '::ffff:7f00:1'],
    ['unique-local', 'fd12:3456::1'],
  ])(
    'blocks a host with ANY %s answer, even next to a public one (DNS rebinding shape)',
    async (_n, addr) => {
      resolveTo('93.184.216.34', addr);
      await expect(assertPublicHttpUrl('https://evil.example/x')).rejects.toThrow(
        'SSRF_BLOCKED: host resolves to a private address'
      );
    }
  );

  it('a failed lookup and an empty one are distinct, both blocked', async () => {
    prev = setHostResolver(async () => {
      throw new Error('DoH down');
    });
    await expect(assertPublicHttpUrl('https://a.example/')).rejects.toThrow(
      'DNS_UNRESOLVED: host lookup failed'
    );
    setHostResolver(async () => []);
    await expect(assertPublicHttpUrl('https://a.example/')).rejects.toThrow(
      'DNS_UNRESOLVED: host resolved to no addresses'
    );
  });

  it('IP literals never reach the resolver', async () => {
    prev = setHostResolver(async () => {
      throw new Error('must not be called');
    });
    await expect(assertPublicHttpUrl('http://127.0.0.1/')).rejects.toThrow(
      'private/loopback IP literal'
    );
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow(
      'private/loopback IP literal'
    );
    await expect(assertPublicHttpUrl('http://8.8.8.8/')).resolves.toBeInstanceOf(URL);
  });

  it('refuses non-http protocols and malformed URLs', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow('disallowed protocol');
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow('malformed URL');
  });
});
