/** Text from an image is data, never instructions: strip control/bidi characters, cap length, flag injection phrasing. */
import { toAsciiDigits } from '../instapay-receipt';

// C0 controls (except \n), DEL, zero-width, bidi marks/overrides/isolates, BOM.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;

export function sanitizeCatalogueText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(CONTROL, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

const MARKERS: Array<[string, RegExp]> = [
  [
    'ignore_instructions',
    /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i,
  ],
  ['disregard', /disregard\s+.{0,24}(?:instructions?|rules?|prompt)/i],
  ['role_override', /\byou\s+are\s+now\b|\bact\s+as\s+(?:a|an)\b|\bpretend\s+(?:to\s+be|you)\b/i],
  ['system_prompt', /system\s+prompt|developer\s+message|new\s+instructions?\s*:/i],
  ['set_prices', /(?:set|change|make)\s+(?:all\s+|every\s+)?(?:the\s+)?prices?\s+(?:to|as)\b/i],
  ['ar_ignore', /تجاهل\s+(?:كل\s+)?(?:ال)?(?:تعليمات|اوامر|أوامر|قواعد)/],
  ['ar_forget', /[اإأ]نسى\s+(?:اللي|كل\s+ما|ما)\s+(?:فات|سبق)/],
  ['ar_prices', /اعتبر\s+(?:كل\s+)?(?:ال)?[اأ]سعار/],
  ['ar_role', /(?:انت|أنت)\s+(?:ال[اآ]ن|دلوقتي)|من\s+ال[اآ]ن\s+(?:انت|أنت)|تعليمات\s+النظام/],
];

/** Flags only; never deletes text (it may be a genuine description). */
export function injectionMarkers(text: string): string[] {
  if (!text) return [];
  const t = toAsciiDigits(text);
  return MARKERS.filter(([, re]) => re.test(t)).map(([id]) => id);
}
