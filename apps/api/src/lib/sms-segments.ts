/**
 * How many billed SMS segments a message costs (issue 2426).
 *
 * Providers bill per segment, not per message. A message that fits the
 * GSM 03.38 alphabet is encoded 7-bit: 160 characters in one segment, 153 per
 * segment once it is split (the rest carries the concatenation header), and
 * each character of the extension table (`^{}\[~]|€` and form feed) costs two.
 * Any other character (Arabic, most emoji, curly quotes) forces UCS-2 for the
 * WHOLE message: 70 UTF-16 code units in one segment, 67 per segment after.
 *
 * Used to make the cost of every queued SMS observable (the dispatcher logs
 * it), so an appended link or a longer template shows up as a number instead
 * of a surprise on the merchant's provider bill.
 */
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM7_EXTENSION = new Set('^{}\\[~]|€\f');

export interface SmsSegmentCount {
  encoding: 'gsm7' | 'ucs2';
  /** Septets (GSM-7) or UTF-16 code units (UCS-2). */
  units: number;
  segments: number;
}

export function smsSegments(text: string): SmsSegmentCount {
  let septets = 0;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXTENSION.has(ch)) septets += 2;
    else {
      const units = text.length; // UTF-16 code units
      return {
        encoding: 'ucs2',
        units,
        segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
      };
    }
  }
  return {
    encoding: 'gsm7',
    units: septets,
    segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
  };
}
