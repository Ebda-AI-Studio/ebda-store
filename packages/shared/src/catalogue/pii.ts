/**
 * Personal data in a catalogue photo (phone and WhatsApp numbers, emails, links, handles) must never
 * reach a product field. Removal is positional on the ORIGINAL text (digits are folded for
 * detection only, one char to one char, so indices line up).
 */
import { toAsciiDigits } from '../instapay-receipt';

export type RemovedKind = 'phone' | 'email' | 'url' | 'handle';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const WA = /\bwa\.me\/\S*/gi;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const HANDLE = /(?<![\w@])@[A-Za-z0-9_.]{2,}/g;
// 9 to 15 digits, optionally separated by space, dash, dot or brackets, with an optional +/00 prefix.
const PHONE = /(?<![\w])(?:\+|00)?\d(?:[\s\-.()]?\d){8,14}(?![\w])/g;

export function redactPersonalData(text: string): { text: string; removed: RemovedKind[] } {
  if (!text) return { text: '', removed: [] };
  const removed: RemovedKind[] = [];
  let out = text;
  const pass = (re: RegExp, kind: RemovedKind) => {
    const folded = toAsciiDigits(out); // same length as `out`
    let result = '';
    let last = 0;
    for (const m of folded.matchAll(re)) {
      const i = m.index ?? 0;
      result += out.slice(last, i);
      last = i + m[0].length;
      if (!removed.includes(kind)) removed.push(kind);
    }
    out = result + out.slice(last);
  };
  pass(WA, 'url');
  pass(EMAIL, 'email');
  pass(URL, 'url');
  pass(HANDLE, 'handle');
  pass(PHONE, 'phone');
  return { text: out.replace(/\s{2,}/g, ' ').trim(), removed };
}
