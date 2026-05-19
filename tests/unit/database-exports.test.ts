import { describe, it, expect } from 'vitest';
import * as db from '@force/database';

describe('@force/database exports', () => {
  it('exports the accounting enums', () => {
    expect(db.AccountType).toBeDefined();
    expect(db.JournalEntrySource).toBeDefined();
    expect(db.JournalEntryStatus).toBeDefined();
    expect(db.AccountType.asset).toBe('asset');
    expect(db.JournalEntrySource.order).toBe('order');
  });
});
