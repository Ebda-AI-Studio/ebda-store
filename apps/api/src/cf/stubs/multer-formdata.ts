/**
 * `multer` on Workers: the subset of its API the API uses, on top of `Request.formData()`.
 *
 * multer streams the request through busboy and a Node stream; under `httpServerHandler` that
 * is an emulated IncomingMessage over the Request body, and busboy is not worth trusting there.
 * The Web platform already parses multipart: wrap the body in a `Response` and call
 * `.formData()`. Used by: routes/upload, expenses, finance, pwa, shipping, all of which use
 * `multer({ storage: multer.memoryStorage(), limits, fileFilter })` with `.single(name)` /
 * `.array(name, max)` and read `req.file` / `req.files` / `req.body`.
 *
 * Same behaviours: non-multipart requests pass through untouched; `fileFilter` runs per file;
 * `limits.fileSize` / `limits.files` raise a `MulterError` with multer's codes via `next(err)`;
 * text fields land on `req.body`; a file on an unexpected field is `LIMIT_UNEXPECTED_FILE`.
 * Like memoryStorage, the whole file is held in memory. `formData()` buffers the WHOLE body before
 * any per-file check can run, so the route limits alone do NOT bound memory: the body is capped
 * BEFORE parsing at `fileSize * files + FRAMING_ALLOWANCE` (Content-Length pre-check, plus a
 * byte-counting transform for chunked bodies or a lying Content-Length). Exceeding it raises the
 * same `MulterError('LIMIT_FILE_SIZE')` real multer raises, so handlers map it to 413 unchanged.
 */
import { Readable, Transform } from 'node:stream';

/** Multipart boundaries, headers and text fields around the files. */
export const FRAMING_ALLOWANCE = 64 * 1024;

type Next = (err?: unknown) => void;

interface MulterLimits {
  fileSize?: number;
  files?: number;
}

interface MulterOptions {
  storage?: unknown;
  limits?: MulterLimits;
  fileFilter?: (
    req: unknown,
    file: { fieldname: string; originalname: string; mimetype: string },
    cb: (err: Error | null, accept?: boolean) => void
  ) => void;
}

export class MulterError extends Error {
  readonly code: string;
  readonly field?: string;
  constructor(code: string, field?: string) {
    super(
      {
        LIMIT_FILE_SIZE: 'File too large',
        LIMIT_FILE_COUNT: 'Too many files',
        LIMIT_UNEXPECTED_FILE: 'Unexpected field',
      }[code] ?? code
    );
    this.name = 'MulterError';
    this.code = code;
    this.field = field;
  }
}

interface ReqLike extends Readable {
  headers: Record<string, string | string[] | undefined>;
  body?: Record<string, unknown>;
  file?: UploadedFile;
  files?: UploadedFile[];
}

interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

type Mode = { kind: 'single'; name: string } | { kind: 'array'; name: string; max: number };

function runFilter(opts: MulterOptions, req: unknown, f: File, field: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (!opts.fileFilter) return resolve(true);
    opts.fileFilter(req, { fieldname: field, originalname: f.name, mimetype: f.type }, (err, ok) =>
      err ? reject(err) : resolve(ok !== false)
    );
  });
}

function middleware(opts: MulterOptions, mode: Mode) {
  return async (req: ReqLike, _res: unknown, next: Next): Promise<void> => {
    const contentType = String(req.headers['content-type'] ?? '');
    if (!/^multipart\/form-data/i.test(contentType)) return next();
    // Bound the buffered body before formData() sees it (see the file comment). With no
    // `limits.files`, an `.array(name, max)` is still bounded by its own `max` files.
    const modeMax = mode.kind === 'single' ? 1 : mode.max;
    const cap =
      opts.limits?.fileSize !== undefined
        ? opts.limits.fileSize * Math.max(1, Math.min(modeMax, opts.limits.files ?? modeMax)) +
          FRAMING_ALLOWANCE
        : Infinity;
    let seen = 0;
    try {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > cap) {
        req.resume();
        throw new MulterError('LIMIT_FILE_SIZE', mode.name);
      }
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > cap) cb(new MulterError('LIMIT_FILE_SIZE', mode.name));
          else cb(null, chunk);
        },
      });
      req.on('error', e => counter.destroy(e));
      const form = await new Response(
        Readable.toWeb(req.pipe(counter)) as unknown as ReadableStream,
        {
          headers: { 'content-type': contentType },
        }
      ).formData();
      const body: Record<string, unknown> = {};
      const files: UploadedFile[] = [];
      const maxFiles = mode.kind === 'single' ? 1 : mode.max;
      const hardFiles = opts.limits?.files ?? Infinity;
      for (const [field, value] of form.entries()) {
        if (typeof value === 'string') {
          body[field] = value;
          continue;
        }
        if (field !== mode.name) throw new MulterError('LIMIT_UNEXPECTED_FILE', field);
        if (files.length >= Math.min(maxFiles, hardFiles)) {
          throw new MulterError(
            mode.kind === 'single' ? 'LIMIT_UNEXPECTED_FILE' : 'LIMIT_FILE_COUNT',
            field
          );
        }
        if (opts.limits?.fileSize !== undefined && value.size > opts.limits.fileSize) {
          throw new MulterError('LIMIT_FILE_SIZE', field);
        }
        if (!(await runFilter(opts, req, value, field))) continue;
        files.push({
          fieldname: field,
          originalname: value.name,
          encoding: '7bit',
          mimetype: value.type,
          size: value.size,
          buffer: Buffer.from(await value.arrayBuffer()),
        });
      }
      req.body = body;
      if (mode.kind === 'single') req.file = files[0];
      else req.files = files;
      next();
    } catch (err) {
      // formData() may surface the counter's abort as its own TypeError ("failed to parse
      // body"), losing the MulterError: the byte count is the truth, so map it back to 413.
      if (seen > cap && !(err instanceof MulterError)) {
        next(new MulterError('LIMIT_FILE_SIZE', mode.name));
        return;
      }
      next(err);
    }
  };
}

function multer(opts: MulterOptions = {}) {
  return {
    single: (name: string) => middleware(opts, { kind: 'single', name }),
    array: (name: string, max = Infinity) => middleware(opts, { kind: 'array', name, max }),
  };
}
multer.memoryStorage = (): unknown => ({ kind: 'memory' });
multer.MulterError = MulterError;

export default multer;
