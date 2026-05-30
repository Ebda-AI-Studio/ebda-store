import { describe, it, expect } from 'vitest';
import { safeDecryptJson } from '../safe-decrypt-json';
import { AppError } from '../../middleware/error-handler';

describe('safeDecryptJson', () => {
  it('parses valid JSON', () => {
    expect(safeDecryptJson('{"a":1}', 'ctx')).toEqual({ a: 1 });
  });

  it('throws a typed AppError on malformed JSON instead of a raw SyntaxError', () => {
    expect(() => safeDecryptJson('not json', 'hesabe')).toThrow(AppError);
    try {
      safeDecryptJson('not json', 'hesabe');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CREDENTIAL_DECRYPT_FAILED');
      expect((e as AppError).statusCode).toBe(500);
    }
  });
});
