/**
 * Which StoreDO tables hold personal data, and how a customer is found in them. Every table the live StoreDO schema
 * holds MUST be classified here before customer erasure/export may run on it (`unclassifiedTables`; the StoreDO
 * refuses a customer subject while any table is unclassified, so a missing entry fails CLOSED, never silently skips PII).
 * Column names are SQLite column names.
 *
 * STATE (INFRA-CF-1 PR D1, Ruling CF-ERASE-3): the registry is GENERATED (registry.generated.ts) from
 * packages/cf-schema/erasure-classification.json and the store migrations by scripts/cf/gen-erasure-registry.mjs; CI runs
 * it with `--check`, so a schema or classification change that is not regenerated fails the build. Every one of the
 * 122 tables is classified, and a table the live DO has that the registry lacks still fails customer subjects closed.
 */

import { GENERATED_STORE_DO_REGISTRY } from './registry.generated';

export type TableClass =
  | { kind: 'no-pii' }
  /** Merchant-owned content with no customer identifiers; goes with `deleteAll()` on merchant erase. */
  | { kind: 'store-owned' }
  | {
      kind: 'customer-pii';
      /** Columns that identify the customer; a row matches when ANY supplied subject key equals ONE of them. */
      match: {
        buyerKey?: string;
        email?: string;
        phone?: string;
        userId?: string;
        /** Column holding a `customers.id`: matched through the customers rows the subject resolves to (see store-do-sql). */
        customerId?: string;
      };
      /** The table has no subject column of its own and is reached through its parent (shipments -> orders). */
      via?: { column: string; table: string };
      /** 'delete' removes the row; 'scrub' keeps it (orders keep money history) and overwrites the columns. */
      action: 'delete' | 'scrub';
      /** For 'scrub': column -> replacement (NOT NULL columns need a string, e.g. '[erased]'). */
      scrub?: Record<string, string | null>;
    };

export const STORE_DO_REGISTRY: Record<string, TableClass> = GENERATED_STORE_DO_REGISTRY;

export const classifiedTables = (): string[] => Object.keys(STORE_DO_REGISTRY);
/** Tables of a live StoreDO (`storeTables(sql)`) that have no registry entry. */
export const unclassifiedTables = (
  liveTables: readonly string[],
  reg: Record<string, TableClass> = STORE_DO_REGISTRY
): string[] => liveTables.filter(t => !(t in reg));
