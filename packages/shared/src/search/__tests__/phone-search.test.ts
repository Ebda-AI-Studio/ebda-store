import { it, expect } from 'vitest';
import { phoneSearchDigits } from '../phone-search';

it.each([
  ['01012345678', '1012345678'],
  ['+20 101 234 5678', '1012345678'],
  ['00201012345678', '1012345678'],
  ['٠١٠١٢٣٤٥٦٧٨', '1012345678'],
  ['۰۱۰۱۲۳۴۵۶۷۸', '1012345678'],
  ['010-1234', '0101234'],
  ['5678', '5678'],
  ['12', null],
  ['احمد', null],
  ['', null],
])('%j -> %j', (q, out) => expect(phoneSearchDigits(q)).toBe(out));
