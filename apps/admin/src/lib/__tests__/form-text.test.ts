/**
 * The admin-side half of the "an emptied text field must clear" fix.
 *
 * The product edit form built its payload with `formData.description ||
 * undefined`. `undefined` is dropped by JSON.stringify, so an emptied
 * textarea omitted the key, the API read that as "leave alone", and the
 * merchant's save persisted (`updatedAt` moved) with the old 226-character
 * description intact. The edit path must send `null`; the create path, which
 * has nothing to clear, must keep sending `undefined`.
 */
import { describe, it, expect } from 'vitest';
import { textFieldValue, numericFieldValue, dateFieldValue } from '../form-text';

/** What the browser would actually put on the wire for a payload value. */
function serialize(value: unknown): string {
  return JSON.stringify({ description: value });
}

describe('textFieldValue — update (edit forms)', () => {
  it('sends null, not undefined, for an emptied field (the reported bug)', () => {
    expect(textFieldValue('', 'update')).toBeNull();
  });

  it('puts the key on the wire as null so the API can clear the column', () => {
    expect(serialize(textFieldValue('', 'update'))).toBe('{"description":null}');
  });

  it('passes a non-empty value through unchanged', () => {
    expect(textFieldValue('A real description', 'update')).toBe('A real description');
  });

  it('treats a null/undefined form value as empty (clear)', () => {
    expect(textFieldValue(null, 'update')).toBeNull();
    expect(textFieldValue(undefined, 'update')).toBeNull();
  });

  it('does not trim — the caller owns trimming, so whitespace is a real value', () => {
    // Callers that want '   ' to count as empty pass `.trim()` themselves;
    // this helper must never silently change what a filled field sends.
    expect(textFieldValue('  ', 'update')).toBe('  ');
    expect(textFieldValue('  '.trim(), 'update')).toBeNull();
  });
});

describe('textFieldValue — create (new-record forms)', () => {
  it('sends undefined for an empty field so the key is omitted entirely', () => {
    expect(textFieldValue('', 'create')).toBeUndefined();
  });

  it('drops the key from the JSON body — there is nothing to clear on a create', () => {
    expect(serialize(textFieldValue('', 'create'))).toBe('{}');
  });

  it('passes a non-empty value through unchanged', () => {
    expect(textFieldValue('A real description', 'create')).toBe('A real description');
  });
});

describe('textFieldValue — runtime intent (shared create-or-edit forms)', () => {
  // categories, locations, tax rates, coupons and warehouses all build ONE
  // body and POST or PUT it depending on whether a record is being edited.
  const forEditingId = (editingId: string | null) => (editingId ? 'update' : 'create');

  it('clears on the edit branch and omits on the create branch', () => {
    expect(textFieldValue('', forEditingId('cat-1'))).toBeNull();
    expect(textFieldValue('', forEditingId(null))).toBeUndefined();
  });

  it('is identical for a filled field on both branches', () => {
    expect(textFieldValue('Sweets', forEditingId('cat-1'))).toBe('Sweets');
    expect(textFieldValue('Sweets', forEditingId(null))).toBe('Sweets');
  });
});

/**
 * CLEAR-1: the numeric sibling of the text field bug. useCoupons.ts sent
 * `formData.minOrderAmount ? parseInt(...) * 1000 : undefined` for
 * minOrderAmount/maxDiscount/usageLimit/usageLimitPerUser, so a merchant who
 * cleared an already-set minimum/cap/limit had the restriction silently
 * survive the save (the PUT succeeded, `updatedAt` moved, nothing changed).
 */
describe('numericFieldValue — update (edit forms)', () => {
  const toFils = (v: string) => parseInt(v, 10) * 1000;

  it('sends null, not undefined, for an emptied field (the reported bug)', () => {
    expect(numericFieldValue('', 'update', toFils)).toBeNull();
  });

  it('runs the parse function and passes a real value through', () => {
    expect(numericFieldValue('5', 'update', toFils)).toBe(5000);
  });

  it('treats a null/undefined form value as empty (clear)', () => {
    expect(numericFieldValue(null, 'update', toFils)).toBeNull();
    expect(numericFieldValue(undefined, 'update', toFils)).toBeNull();
  });

  it('never runs parse on an empty value — parse only sees real input', () => {
    let called = false;
    numericFieldValue('', 'update', v => {
      called = true;
      return parseInt(v, 10);
    });
    expect(called).toBe(false);
  });
});

describe('numericFieldValue — create (new-record forms)', () => {
  const toFils = (v: string) => parseInt(v, 10) * 1000;

  it('sends undefined for an empty field so the key is omitted entirely', () => {
    expect(numericFieldValue('', 'create', toFils)).toBeUndefined();
  });

  it('runs the parse function and passes a real value through unchanged', () => {
    expect(numericFieldValue('5', 'create', toFils)).toBe(5000);
  });
});

/**
 * CLEAR-1: the date sibling — useCoupons.ts sent
 * `formData.startsAt ? new Date(...).toISOString() : undefined`, so clearing
 * an expiry date left the old expiry in place and the coupon kept expiring.
 */
describe('dateFieldValue — update (edit forms)', () => {
  it('sends null, not undefined, for an emptied field (the reported bug)', () => {
    expect(dateFieldValue('', 'update')).toBeNull();
  });

  it('converts a real value to an ISO string', () => {
    expect(dateFieldValue('2026-12-01T00:00', 'update')).toBe(
      new Date('2026-12-01T00:00').toISOString()
    );
  });

  it('treats a null/undefined form value as empty (clear)', () => {
    expect(dateFieldValue(null, 'update')).toBeNull();
    expect(dateFieldValue(undefined, 'update')).toBeNull();
  });
});

describe('dateFieldValue — create (new-record forms)', () => {
  it('sends undefined for an empty field so the key is omitted entirely', () => {
    expect(dateFieldValue('', 'create')).toBeUndefined();
  });

  it('converts a real value to an ISO string unchanged', () => {
    expect(dateFieldValue('2026-12-01T00:00', 'create')).toBe(
      new Date('2026-12-01T00:00').toISOString()
    );
  });
});
