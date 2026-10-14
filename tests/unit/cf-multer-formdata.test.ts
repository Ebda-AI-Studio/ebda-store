/** The `multer` replacement used on Workers (apps/api/src/cf/stubs/multer-formdata.ts), on Request.formData(). */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import multer, {
  MulterError,
  FRAMING_ALLOWANCE,
} from '../../apps/api/src/cf/stubs/multer-formdata';

async function run(
  mw: (req: any, res: unknown, next: (e?: unknown) => void) => Promise<void>,
  form: FormData | null,
  headers: Record<string, string> = {}
) {
  let req: any;
  if (form) {
    const r = new Request('http://x/upload', { method: 'POST', body: form });
    req = Object.assign(Readable.fromWeb(r.body as any), {
      headers: { 'content-type': r.headers.get('content-type')!, ...headers },
    });
  } else {
    req = Object.assign(Readable.from([]), {
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  const err = await new Promise<unknown>(resolve => void mw(req, {}, resolve));
  return { req, err };
}

const file = (name: string, type: string, bytes: number) =>
  new File([new Uint8Array(bytes).fill(7)], name, { type });

describe('multer on Request.formData()', () => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024, files: 2 },
    fileFilter: (_req, f, cb) =>
      f.mimetype.startsWith('image/')
        ? cb(null, true)
        : cb(new Error(`Invalid file type: ${f.mimetype}`)),
  });

  it(".single(): puts the file on req.file with multer's shape, and text fields on req.body", async () => {
    const form = new FormData();
    form.set('file', file('logo.png', 'image/png', 100));
    form.set('alt', 'a logo');
    const { req, err } = await run(upload.single('file'), form);
    expect(err).toBeUndefined();
    expect(req.file).toMatchObject({
      fieldname: 'file',
      originalname: 'logo.png',
      mimetype: 'image/png',
      size: 100,
    });
    expect(Buffer.isBuffer(req.file.buffer)).toBe(true);
    expect(req.file.buffer.length).toBe(100);
    expect(req.file.buffer[0]).toBe(7);
    expect(req.body).toEqual({ alt: 'a logo' });
  });

  it('.array(): collects req.files up to the max', async () => {
    const form = new FormData();
    form.append('files', file('a.png', 'image/png', 10));
    form.append('files', file('b.jpg', 'image/jpeg', 10));
    const { req, err } = await run(upload.array('files', 10), form);
    expect(err).toBeUndefined();
    expect(req.files.map((f: any) => f.originalname)).toEqual(['a.png', 'b.jpg']);
  });

  it('a request that is not multipart passes straight through, untouched', async () => {
    const { req, err } = await run(upload.single('file'), null);
    expect(err).toBeUndefined();
    expect(req.file).toBeUndefined();
  });

  it('LIMIT_FILE_SIZE for a file over limits.fileSize', async () => {
    const form = new FormData();
    form.set('file', file('big.png', 'image/png', 4096));
    const { err } = await run(upload.single('file'), form);
    expect(err).toBeInstanceOf(MulterError);
    expect((err as MulterError).code).toBe('LIMIT_FILE_SIZE');
  });

  it('LIMIT_UNEXPECTED_FILE for a file on the wrong field, and for a second file on .single()', async () => {
    const wrong = new FormData();
    wrong.set('other', file('a.png', 'image/png', 10));
    expect(((await run(upload.single('file'), wrong)).err as MulterError).code).toBe(
      'LIMIT_UNEXPECTED_FILE'
    );
    const two = new FormData();
    two.append('file', file('a.png', 'image/png', 10));
    two.append('file', file('b.png', 'image/png', 10));
    expect(((await run(upload.single('file'), two)).err as MulterError).code).toBe(
      'LIMIT_UNEXPECTED_FILE'
    );
  });

  it('LIMIT_FILE_COUNT past limits.files on .array()', async () => {
    const form = new FormData();
    for (let i = 0; i < 3; i++) form.append('files', file(`${i}.png`, 'image/png', 10));
    expect(((await run(upload.array('files', 10), form)).err as MulterError).code).toBe(
      'LIMIT_FILE_COUNT'
    );
  });

  it('the fileFilter error is passed to next() like multer does', async () => {
    const form = new FormData();
    form.set('file', file('x.exe', 'application/octet-stream', 10));
    const { err } = await run(upload.single('file'), form);
    expect((err as Error).message).toBe('Invalid file type: application/octet-stream');
  });

  it('exposes memoryStorage and MulterError like the real package', () => {
    expect(multer.memoryStorage()).toBeTruthy();
    expect(new MulterError('LIMIT_FILE_SIZE', 'f').message).toBe('File too large');
    expect(multer.MulterError).toBe(MulterError);
  });
});

describe('pre-parse body cap (formData() buffers everything, so the route limit must not be trusted)', () => {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024, files: 1 } });
  const CAP = 1024 + FRAMING_ALLOWANCE;

  function rawRun(chunks: Buffer[], headers: Record<string, string>) {
    const req: any = Object.assign(Readable.from(chunks), { headers });
    return new Promise<{ req: any; err: unknown }>(resolve => {
      void upload.single('file')(req, {}, (err?: unknown) => resolve({ req, err }));
    });
  }

  it('an oversize Content-Length is rejected as LIMIT_FILE_SIZE without reading the body', async () => {
    let pulled = 0;
    const req: any = Object.assign(
      new Readable({
        read() {
          pulled++;
          this.push(null);
        },
      }),
      {
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(CAP + 1),
        },
      }
    );
    const err = await new Promise<unknown>(resolve => void upload.single('file')(req, {}, resolve));
    expect(err).toBeInstanceOf(MulterError);
    expect((err as MulterError).code).toBe('LIMIT_FILE_SIZE');
    expect(pulled).toBe(0);
  });

  it('a chunked body past the cap with NO Content-Length errors as LIMIT_FILE_SIZE', async () => {
    const chunk = Buffer.alloc(32 * 1024, 1);
    const chunks = Array.from({ length: 4 }, () => chunk); // 128 KB > CAP
    const { err } = await rawRun(chunks, { 'content-type': 'multipart/form-data; boundary=x' });
    expect(err).toBeInstanceOf(MulterError);
    expect((err as MulterError).code).toBe('LIMIT_FILE_SIZE');
  });

  it('a lying (small) Content-Length does not bypass the counter', async () => {
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(32 * 1024, 1));
    const { err } = await rawRun(chunks, {
      'content-type': 'multipart/form-data; boundary=x',
      'content-length': '10',
    });
    expect((err as MulterError).code).toBe('LIMIT_FILE_SIZE');
  });

  it('a body under the cap still parses', async () => {
    const form = new FormData();
    form.set('file', file('ok.png', 'image/png', 900));
    const { req, err } = await run(upload.single('file'), form);
    expect(err).toBeUndefined();
    expect(req.file.size).toBe(900);
  });
});
