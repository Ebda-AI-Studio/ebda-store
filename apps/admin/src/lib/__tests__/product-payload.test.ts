/**
 * The admin half of the product "an emptied text field must clear" defect.
 *
 * A merchant emptied a product's English description and saved. `updatedAt`
 * moved, so the write landed — but the 226-character description survived,
 * because the edit page built its body with `formData.description ||
 * undefined` and `undefined` is dropped by JSON.stringify. The API then read
 * the missing key as "leave alone".
 *
 * The edit payload must send `null` for an emptied field; the create payload
 * must keep sending `undefined` (there is nothing to clear on a create).
 */
import { describe, it, expect } from 'vitest';
import { productTextFields, type ProductTextFieldsForm } from '../product-payload';

const FIELDS = ['nameAr', 'description', 'descriptionAr', 'sku'] as const;

function form(overrides: Partial<ProductTextFieldsForm> = {}): ProductTextFieldsForm {
  return { nameAr: '', description: '', descriptionAr: '', sku: '', ...overrides };
}

describe('productTextFields — edit form (update)', () => {
  it('sends null for an emptied description (the reported bug)', () => {
    const payload = productTextFields(form({ description: '' }), 'update');
    expect(payload.description).toBeNull();
  });

  it.each(FIELDS)('sends null for an emptied %s', field => {
    expect(productTextFields(form(), 'update')[field]).toBeNull();
  });

  it('puts every emptied field on the wire as null', () => {
    expect(JSON.parse(JSON.stringify(productTextFields(form(), 'update')))).toEqual({
      nameAr: null,
      description: null,
      descriptionAr: null,
      sku: null,
    });
  });

  it('passes filled fields through untouched — a normal save is unchanged', () => {
    const payload = productTextFields(
      form({
        nameAr: 'زبدة البيكان',
        description: 'A long English description.',
        descriptionAr: 'وصف عربي',
        sku: 'PB-001',
      }),
      'update'
    );
    expect(payload).toEqual({
      nameAr: 'زبدة البيكان',
      description: 'A long English description.',
      descriptionAr: 'وصف عربي',
      sku: 'PB-001',
    });
  });

  it('clears only the emptied field, leaving its siblings alone', () => {
    const payload = productTextFields(
      form({ nameAr: 'زبدة البيكان', description: '', sku: 'PB-001' }),
      'update'
    );
    expect(payload.description).toBeNull();
    expect(payload.nameAr).toBe('زبدة البيكان');
    expect(payload.sku).toBe('PB-001');
  });

  it('never emits `name` — it is required and must not become nullable', () => {
    expect(Object.keys(productTextFields(form(), 'update')).sort()).toEqual(
      ['description', 'descriptionAr', 'nameAr', 'sku'].sort()
    );
  });
});

describe('productTextFields — new-product form (create)', () => {
  it.each(FIELDS)('sends undefined for an empty %s so the key is omitted', field => {
    expect(productTextFields(form(), 'create')[field]).toBeUndefined();
  });

  it('drops every empty field from the JSON body', () => {
    expect(JSON.parse(JSON.stringify(productTextFields(form(), 'create')))).toEqual({});
  });

  it('passes filled fields through untouched', () => {
    const payload = productTextFields(form({ description: 'Hello', sku: 'PB-002' }), 'create');
    expect(payload.description).toBe('Hello');
    expect(payload.sku).toBe('PB-002');
  });
});
