import { describe, expect, it } from 'vitest';
import { merchantSignupSchema } from '@api/services/merchant-signup.service';
const base = { email: 'merchant@example.org', name: 'Mona', password: 'Str0ng!Passw0rd' };
describe('required merchant mobile at API edge', () => {
  it.each([undefined, '', '   ', '12345', '+96550000000'])(
    'rejects missing or invalid mobile %s',
    phone => {
      expect(merchantSignupSchema.safeParse({ ...base, phone }).success).toBe(false);
    }
  );
  it.each(['01012345678', '+201012345678', '٠١٠١٢٣٤٥٦٧٨'])('accepts Egyptian mobile %s', phone => {
    expect(merchantSignupSchema.safeParse({ ...base, phone }).success).toBe(true);
  });
});
