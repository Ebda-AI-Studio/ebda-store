// The email-campaigns migration may change data in exactly one way: turning
// every existing `email_campaigns` override OFF (a stale enabled row from when
// the flag was hidden would otherwise go live on deploy). Same comment-stripped
// SQL-reading pattern as bundle-schema.test.ts, so prose cannot satisfy it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(
  __dirname,
  '../../packages/database/prisma/migrations/20260925120000_email_campaigns'
);
const code = (file: string) =>
  readFileSync(resolve(DIR, file), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

describe('20260925120000_email_campaigns data changes', () => {
  const sql = code('migration.sql');

  it('resets every email_campaigns override to OFF', () => {
    expect(sql).toMatch(
      /UPDATE\s+"store_features"\s+SET\s+"enabled"\s*=\s*false\s+WHERE\s+"feature_key"\s*=\s*'email_campaigns'\s*;/i
    );
  });

  it('never turns anything on, inserts rows or deletes rows', () => {
    // Statement-level only: `ON UPDATE CASCADE`, `FOR UPDATE` policies and
    // the RLS predicate's `'app.bypass_rls', true` are DDL, not data writes.
    const updates = sql.match(/^\s*UPDATE\s+[^;]*;/gim) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET\s+"enabled"\s*=\s*false/i);
    expect(sql).not.toMatch(/^\s*INSERT\s+INTO\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM\b/im);
  });

  it('rollback does not re-enable anything', () => {
    const rollback = code('rollback.sql');
    expect(rollback).not.toMatch(/store_features/i);
    expect(rollback).not.toMatch(/^\s*(UPDATE|INSERT)\b/im);
  });
});
