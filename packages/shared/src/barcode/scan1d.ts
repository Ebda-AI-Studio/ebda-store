/**
 * In-house 1D barcode reader (Ruling BARCODE-1a): Code 128 (sets B and C, with B/C switches) and
 * EAN-13 / UPC-A, checksum-verified. It exists for ONE job: the scan self-check, so a label that
 * will not scan is never printed. No dependency (the maintained 1D readers are WASM blobs or
 * older than our 12-month rule).
 *
 * Method: sample several horizontal scanlines through the rendered image, threshold each at the
 * midpoint of its own light/dark levels, measure run lengths, match them to the symbol tables,
 * verify the check character. A read PASSES only when at least `minAgree` scanlines (default 2)
 * decode to the same value. A scanline also fails when there is no real quiet zone on each side
 * or the light/dark contrast is too low, so a clipped or washed-out label cannot pass.
 */
import { CODE128_WIDTHS } from './code128';
import { EAN_G, EAN_L, EAN_PARITY, EAN_R, isValidEan13 } from './ean';

export type Image1d = { width: number; height: number; data: ArrayLike<number> };
export type Symbology = 'code128' | 'ean13';
export type LineRead = { kind: Symbology; value: string };
export type ScanResult = {
  ok: boolean;
  kind: Symbology | null;
  value: string | null;
  /** Scanlines that decoded to `value`. */
  agree: number;
  lines: number;
  reason: 'ok' | 'no-agreement' | 'low-contrast';
};

/** Light/dark spread (0-255) a line needs: below this the print is too faint to trust. */
export const MIN_CONTRAST = 80;
/** Quiet zone, in modules, required on both sides. Code 128 specifies 10, EAN-13 11/7; scanners tolerate less. */
export const MIN_QUIET_MODULES = 6;
const MAX_PATTERN_ERROR = 2.2;

function luminanceLine(img: Image1d, y: number): Uint8Array {
  const out = new Uint8Array(img.width);
  const row = y * img.width * 4;
  for (let x = 0; x < img.width; x++) {
    const o = row + x * 4;
    const a = img.data[o + 3] / 255;
    // composite over white, then Rec.601 luma
    const r = img.data[o] * a + 255 * (1 - a);
    const g = img.data[o + 1] * a + 255 * (1 - a);
    const b = img.data[o + 2] * a + 255 * (1 - a);
    out[x] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}

function levels(line: Uint8Array): { lo: number; hi: number } {
  const sorted = Uint8Array.from(line).sort();
  return {
    lo: sorted[Math.floor(sorted.length * 0.05)],
    hi: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
  };
}

type Runs = { quietL: number; widths: number[]; quietR: number };

/** Alternating bar/space widths from the first to the last dark pixel, plus the light margins. */
function toRuns(line: Uint8Array, threshold: number): Runs | null {
  const dark = (i: number) => line[i] < threshold;
  let first = 0;
  while (first < line.length && !dark(first)) first++;
  if (first === line.length) return null;
  let last = line.length - 1;
  while (last > first && !dark(last)) last--;
  const widths: number[] = [];
  let cur = true;
  let n = 0;
  for (let i = first; i <= last; i++) {
    if (dark(i) === cur) n++;
    else {
      widths.push(n);
      cur = !cur;
      n = 1;
    }
  }
  widths.push(n);
  return { quietL: first, widths, quietR: line.length - 1 - last };
}

function patternError(runs: number[], module: number, pattern: string): number {
  let e = 0;
  for (let i = 0; i < pattern.length; i++) e += Math.abs(runs[i] / module - Number(pattern[i]));
  return e;
}

const C128 = CODE128_WIDTHS.slice(0, 106);
const STOP_PATTERN = CODE128_WIDTHS[106];

/** The Code 128 symbol whose 6 run widths best fit `runs` (any scale), or null when none is close enough. Exported for tests. */
export function matchCode128Symbol(runs: number[]): number | null {
  const total = runs.reduce((a, b) => a + b, 0);
  const module = total / 11;
  let best = -1;
  let bestErr = Infinity;
  for (let c = 0; c < C128.length; c++) {
    const e = patternError(runs, module, C128[c]);
    if (e < bestErr) {
      bestErr = e;
      best = c;
    }
  }
  return bestErr <= MAX_PATTERN_ERROR ? best : null;
}

function decodeCode128Runs(r: Runs): string | null {
  const w = r.widths;
  if (w.length < 6 * 3 + 7 || (w.length - 7) % 6 !== 0) return null;
  const symbolCount = (w.length - 7) / 6;
  // module size from the whole symbol set (start..check span 11 modules each) + stop (13)
  const stopRuns = w.slice(w.length - 7);
  const stopModule = stopRuns.reduce((a, b) => a + b, 0) / 13;
  if (patternError(stopRuns, stopModule, STOP_PATTERN) > MAX_PATTERN_ERROR + 0.6) return null;
  const module = w.slice(0, w.length - 7).reduce((a, b) => a + b, 0) / (symbolCount * 11 + 0) || 0;
  if (!module || r.quietL < MIN_QUIET_MODULES * module || r.quietR < MIN_QUIET_MODULES * module)
    return null;

  const codes: number[] = [];
  for (let s = 0; s < symbolCount; s++) {
    const code = matchCode128Symbol(w.slice(s * 6, s * 6 + 6));
    if (code === null) return null;
    codes.push(code);
  }
  const start = codes[0];
  if (start !== 104 && start !== 105) return null; // start B / C only
  let sum = start;
  for (let i = 1; i < codes.length - 1; i++) sum += codes[i] * i;
  if (sum % 103 !== codes[codes.length - 1]) return null;

  let set: 'B' | 'C' = start === 105 ? 'C' : 'B';
  let out = '';
  for (let i = 1; i < codes.length - 1; i++) {
    const c = codes[i];
    if (set === 'C') {
      if (c <= 99) out += String(c).padStart(2, '0');
      else if (c === 100) set = 'B';
      else return null;
    } else if (c <= 94) out += String.fromCharCode(c + 32);
    else if (c === 99) set = 'C';
    else return null;
  }
  return out || null;
}

function decodeEan13Runs(r: Runs): string | null {
  const w = r.widths;
  if (w.length !== 59) return null;
  const module = w.reduce((a, b) => a + b, 0) / 95;
  if (!module || r.quietL < MIN_QUIET_MODULES * module || r.quietR < MIN_QUIET_MODULES * module)
    return null;
  const guard = (a: number[], p: string) => patternError(a, module, p) <= 1.6;
  if (
    !guard(w.slice(0, 3), '111') ||
    !guard(w.slice(27, 32), '11111') ||
    !guard(w.slice(56, 59), '111')
  )
    return null;

  const digitAt = (start: number, tables: string[][]) => {
    const runs = w.slice(start, start + 4);
    let best = -1;
    let bestT = -1;
    let bestErr = Infinity;
    tables.forEach((table, ti) =>
      table.forEach((bits, d) => {
        const e = patternError(runs, module, bitsToWidths(bits));
        if (e < bestErr) {
          bestErr = e;
          best = d;
          bestT = ti;
        }
      })
    );
    return bestErr <= MAX_PATTERN_ERROR - 0.4 ? { d: best, t: bestT } : null;
  };

  const left: number[] = [];
  let parity = '';
  for (let i = 0; i < 6; i++) {
    const hit = digitAt(3 + i * 4, [EAN_L, EAN_G]);
    if (!hit) return null;
    left.push(hit.d);
    parity += hit.t === 0 ? 'L' : 'G';
  }
  const first = EAN_PARITY.indexOf(parity);
  if (first < 0) return null;
  const right: number[] = [];
  for (let i = 0; i < 6; i++) {
    const hit = digitAt(32 + i * 4, [EAN_R]);
    if (!hit) return null;
    right.push(hit.d);
  }
  const value = `${first}${left.join('')}${right.join('')}`;
  return isValidEan13(value) ? value : null;
}

const widthsCache = new Map<string, string>();
/** '0001101' -> '3211' style run widths (starting from the first run of the 7 modules, bar or space as the digit begins). */
function bitsToWidths(bits: string): string {
  const hit = widthsCache.get(bits);
  if (hit) return hit;
  let out = '';
  let n = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] === bits[i - 1]) n++;
    else {
      out += n;
      n = 1;
    }
  }
  out += n;
  widthsCache.set(bits, out);
  return out;
}

/**
 * EAN digits start at the module boundary but their first run polarity differs (L/G start with a
 * space, R with a bar). Because we slice runs by index from the start guard, the 4 runs of a digit
 * always begin with a space (left half) or a bar (right half), exactly as the tables are written,
 * but a digit whose first/last module run is merged with the neighbour guard loses a run. The
 * 59-run length check above rejects any line where that happens.
 */
function readLine(line: Uint8Array): LineRead | null {
  const { lo, hi } = levels(line);
  if (hi - lo < MIN_CONTRAST) return null;
  const mid = (lo + hi) / 2;
  const bias = (hi - lo) * 0.12;
  for (const t of [mid, mid + bias, mid - bias]) {
    const runs = toRuns(line, t);
    if (!runs) continue;
    for (const r of [
      runs,
      { quietL: runs.quietR, widths: [...runs.widths].reverse(), quietR: runs.quietL },
    ]) {
      const ean = decodeEan13Runs(r);
      if (ean) return { kind: 'ean13', value: ean };
      const c128 = decodeCode128Runs(r);
      if (c128) return { kind: 'code128', value: c128 };
    }
  }
  return null;
}

/** Decode one image row (exported for the tests). */
export function readScanline(img: Image1d, y: number): LineRead | null {
  return readLine(luminanceLine(img, y));
}

/**
 * Sample `lines` evenly spaced rows between 5% and 95% of the height and require `minAgree` of
 * them to decode to the same value.
 */
export function decodeLinear(
  img: Image1d,
  opts: { lines?: number; minAgree?: number } = {}
): ScanResult {
  const lines = opts.lines ?? 15;
  const minAgree = opts.minAgree ?? 2;
  const tally = new Map<string, { read: LineRead; n: number }>();
  let contrastOk = false;
  for (let i = 0; i < lines; i++) {
    const y = Math.min(
      img.height - 1,
      Math.floor(img.height * (0.05 + (0.9 * i) / Math.max(1, lines - 1)))
    );
    const line = luminanceLine(img, y);
    const { lo, hi } = levels(line);
    if (hi - lo >= MIN_CONTRAST) contrastOk = true;
    const read = readLine(line);
    if (!read) continue;
    const key = `${read.kind}:${read.value}`;
    const hit = tally.get(key);
    if (hit) hit.n++;
    else tally.set(key, { read, n: 1 });
  }
  let best: { read: LineRead; n: number } | null = null;
  for (const v of tally.values()) if (!best || v.n > best.n) best = v;
  if (best && best.n >= minAgree) {
    return {
      ok: true,
      kind: best.read.kind,
      value: best.read.value,
      agree: best.n,
      lines,
      reason: 'ok',
    };
  }
  return {
    ok: false,
    kind: null,
    value: null,
    agree: best?.n ?? 0,
    lines,
    reason: contrastOk ? 'no-agreement' : 'low-contrast',
  };
}

/** Pass only when the image reads back EXACTLY `expected` (a UPC-A may be compared as its 12 digits). */
export function selfCheckLinear(
  img: Image1d,
  expected: string,
  opts?: { lines?: number; minAgree?: number }
): ScanResult & { matches: boolean } {
  const r = decodeLinear(img, opts);
  const got = r.value;
  const matches = !!got && (got === expected || (r.kind === 'ean13' && got === `0${expected}`));
  return { ...r, ok: r.ok && matches, matches };
}
