/**
 * Code 128 encoder (subsets B and C). Subset C for an all-digit even-length
 * value (half the width), subset B otherwise (ASCII 32..126). Order numbers
 * look like `ORD-MJ4K9L2A-AB3XY`, so B is the working case.
 */
const WIDTHS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 ' +
  '232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 ' +
  '313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 ' +
  '111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 ' +
  '114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'
).split(' ');

const START_B = 104;
const START_C = 105;
const STOP = 106;

export function encodeCode128(value: string): number[] {
  if (!value) throw new Error('code128: empty value');
  const codes: number[] = [];
  if (/^\d+$/.test(value) && value.length % 2 === 0) {
    codes.push(START_C);
    for (let i = 0; i < value.length; i += 2) codes.push(Number(value.slice(i, i + 2)));
  } else {
    codes.push(START_B);
    for (const ch of value) {
      const c = ch.codePointAt(0)!;
      if (c < 32 || c > 126)
        throw new Error(`code128: unsupported character ${JSON.stringify(ch)}`);
      codes.push(c - 32);
    }
  }
  let sum = codes[0]!;
  for (let i = 1; i < codes.length; i++) sum += codes[i]! * i;
  codes.push(sum % 103, STOP);
  return codes;
}

/** Bar (true) / space (false) per module, start pattern through stop bar. */
export function code128Modules(value: string): boolean[] {
  const out: boolean[] = [];
  for (const code of encodeCode128(value)) {
    let bar = true;
    for (const w of WIDTHS[code]!) {
      for (let i = 0; i < Number(w); i++) out.push(bar);
      bar = !bar;
    }
  }
  return out;
}
