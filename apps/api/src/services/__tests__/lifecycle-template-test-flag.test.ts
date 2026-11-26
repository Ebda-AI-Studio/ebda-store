import { describe, it, expect } from 'vitest';
import { lifecycleSubject } from '../email-templates/lifecycle';
import { oneClickUnsubscribeHeaders } from '../../lib/lifecycle-unsubscribe-token';

const base = {
  kind: 'add_products' as const,
  storeName: 'Amelia',
  links: { products: 'p', payment: 'q', storefront: 's', billing: 'b' },
  unsubscribeUrl: 'https://api.ebda.app/u?token=x',
};

describe('lifecycle test flag + RFC 8058 headers', () => {
  it('prefixes the subject only for a test send', () => {
    expect(lifecycleSubject(base, 'en')).toBe('Add your first 3 products in 5 minutes');
    expect(lifecycleSubject({ ...base, isTest: true }, 'en')).toBe(
      '[Test] Add your first 3 products in 5 minutes'
    );
    expect(lifecycleSubject({ ...base, isTest: true }, 'ar').startsWith('[تجربة] ')).toBe(true);
  });
  it('carries List-Unsubscribe + One-Click post header for an https link', () => {
    expect(oneClickUnsubscribeHeaders(base.unsubscribeUrl)).toEqual({
      'List-Unsubscribe': '<https://api.ebda.app/u?token=x>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });
});
