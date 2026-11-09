import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '../src/lib/s3-bundle';

/**
 * S3 XML on real workerd. `@aws-sdk/client-s3` parses every XML response (ListObjectsV2, DeleteObjects, the XML error body of a
 * failed call). Bundled for workerd the SDK picks `@aws-sdk/xml-builder`'s `browser` parser, which needs the global DOMParser that
 * Workers lack: `ReferenceError: DOMParser is not defined` (prod P1, catalog-import-uploads-sweep). wrangler.jsonc aliases
 * `@aws-sdk/xml-builder` to src/cf/stubs/aws-xml-builder.ts (the SDK's own dependency-free parser). These tests drive the BUILT
 * Worker (the alias applied), with gateway-stub answering as an S3 endpoint with the real XML shapes (vitest.workers.config.mts).
 */
const e = env as unknown as {
  JOBS_WORKFLOW: {
    create(o: { id: string; params: unknown }): Promise<{ id: string }>;
    get(id: string): Promise<{ status(): Promise<{ status: string; error?: unknown }> }>;
  };
  PLATFORM_DB: unknown;
  TEST_PLATFORM_MIGRATIONS: unknown[];
  S3_STUB: { fetch(url: string): Promise<Response> };
};

async function run(fn: string): Promise<{ status: string; error?: unknown }> {
  const id = `t-${fn}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await e.JOBS_WORKFLOW.create({
    id,
    params: { fn, event: { name: 'inngest/scheduled.timer', id: 'e1', data: {} } },
  });
  const inst = await e.JOBS_WORKFLOW.get(id);
  for (let i = 0; i < 300; i++) {
    const s = await inst.status();
    if (['complete', 'errored', 'terminated'].includes(s.status)) return s;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${fn} did not finish`);
}

const calls = async (): Promise<string[]> =>
  (await e.S3_STUB.fetch('https://s3-stub.test/__calls')).json();

describe('S3 XML responses parse in workerd', () => {
  it('fixture: the platform D1 schema (the job guard reads stores.storage_backend)', async () => {
    await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
  });

  it('catalog-import-uploads-sweep: lists store prefixes + objects, batch-deletes the expired ones', async () => {
    const before = (await calls()).length;
    const s = await run('catalog-import-uploads-sweep');
    expect(s.status, JSON.stringify(s.error)).toBe('complete');
    const mine = (await calls()).slice(before);
    expect(mine.some(c => c.startsWith('GET /private/?') && c.includes('delimiter=%2F'))).toBe(
      true
    );
    expect(mine.some(c => c.startsWith('GET /private/?') && c.includes('catalogimport-'))).toBe(
      true
    );
    expect(mine.some(c => c.startsWith('POST /private/?delete'))).toBe(true);
  });

  it('r2-orphan-sweep: lists the bucket (ListObjectsV2 XML) without a DOMParser error', async () => {
    const before = (await calls()).length;
    const s = await run('r2-orphan-sweep');
    expect(String(JSON.stringify(s.error ?? ''))).not.toMatch(/DOMParser|Deserialization/);
    expect((await calls()).slice(before).some(c => c.startsWith('GET /uploads/?'))).toBe(true);
  });
});

// The same SDK, imported in the test Worker through src/lib/s3-bundle.ts (vitest.workers.config.mts aliases @aws-sdk/xml-builder
// exactly like wrangler.jsonc does): the three response shapes in isolation, with the typed result and the typed error.
describe('S3 client, XML bodies parsed in workerd', () => {
  const realFetch = globalThis.fetch;
  const xml = (body: string, status = 200) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
      status,
      headers: { 'content-type': 'application/xml' },
    });
  const client = () =>
    new S3Client({
      endpoint: 'https://s3-unit.test',
      region: 'auto',
      credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      forcePathStyle: true,
    });
  const stubFetch = (res: Response) => {
    globalThis.fetch = (async () => res) as typeof fetch;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
  };

  it('DOMParser really is absent here (the premise of the defect)', () => {
    expect(typeof (globalThis as { DOMParser?: unknown }).DOMParser).toBe('undefined');
  });

  it('ListObjectsV2: Contents, CommonPrefixes, truncation, entities', async () => {
    stubFetch(
      xml(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>' +
          '<Contents><Key>a &amp; b.png</Key><LastModified>2020-01-01T00:00:00.000Z</LastModified><Size>5</Size></Contents>' +
          '<Contents><Key>c.png</Key><LastModified>2020-01-02T00:00:00.000Z</LastModified><Size>6</Size></Contents>' +
          '<CommonPrefixes><Prefix>stores/s1/</Prefix></CommonPrefixes></ListBucketResult>'
      )
    );
    try {
      const res = await client().send(new ListObjectsV2Command({ Bucket: 'b' }));
      expect(res.Contents?.map(o => o.Key)).toEqual(['a & b.png', 'c.png']);
      expect(res.Contents?.[0]?.LastModified).toEqual(new Date('2020-01-01T00:00:00.000Z'));
      expect(res.CommonPrefixes?.[0]?.Prefix).toBe('stores/s1/');
      expect(res.IsTruncated).toBe(true);
      expect(res.NextContinuationToken).toBe('tok');
    } finally {
      restore();
    }
  });

  it('DeleteObjects: serialises the request XML and parses Deleted + Errors', async () => {
    let sent = '';
    globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
      sent = input instanceof Request ? await input.text() : String(init?.body ?? '');
      return xml(
        '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>a</Key></Deleted><Error><Key>b</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>'
      );
    }) as typeof fetch;
    try {
      const res = await client().send(
        new DeleteObjectsCommand({ Bucket: 'b', Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }] } })
      );
      expect(sent).toContain('<Key>a</Key>');
      expect(sent).toContain('<Key>b</Key>');
      expect(res.Deleted?.map(d => d.Key)).toEqual(['a']);
      expect(res.Errors?.[0]?.Code).toBe('AccessDenied');
    } finally {
      restore();
    }
  });

  it('an XML error body surfaces as the typed S3 error, not a ReferenceError', async () => {
    stubFetch(
      xml(
        '<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><RequestId>r1</RequestId></Error>',
        404
      )
    );
    try {
      const err = await client()
        .send(new ListObjectsV2Command({ Bucket: 'nope' }))
        .then(
          () => null,
          (x: unknown) =>
            x as { name: string; message: string; $metadata?: { httpStatusCode?: number } }
        );
      expect(err?.name).toBe('NoSuchBucket');
      expect(err?.$metadata?.httpStatusCode).toBe(404);
      expect(err?.message).not.toMatch(/DOMParser/);
    } finally {
      restore();
    }
  });
});
