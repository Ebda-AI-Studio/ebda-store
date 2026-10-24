/**
 * Which StoreDO tables hold personal data, and how a customer is found in them. Every table in
 * STORE_TABLES MUST be classified here (a unit test fails the PR that adds a table without deciding):
 * that is the contract with the phase-1 schema owner. Column names are SQLite column names.
 */
import { STORE_TABLES } from '../store-do/tables';

export type TableClass =
  | { kind: 'no-pii' }
  /** Merchant-owned content with no customer identifiers; goes with `deleteAll()` on merchant erase. */
  | { kind: 'store-owned' }
  | {
      kind: 'customer-pii';
      /** Columns that identify the customer; a row matches when ANY supplied subject key equals ONE of them. */
      match: { buyerKey?: string; email?: string; phone?: string; userId?: string };
      /** 'delete' removes the row; 'scrub' keeps it (orders keep money history) and overwrites the columns. */
      action: 'delete' | 'scrub';
      /** For 'scrub': column -> replacement (NOT NULL columns need a string, e.g. '[erased]'). */
      scrub?: Record<string, string | null>;
    };

export const STORE_DO_REGISTRY: Record<string, TableClass> = {
  stores: { kind: 'store-owned' },
  products: { kind: 'store-owned' },
  product_variants: { kind: 'store-owned' },
  // carts: session_id is a random cookie id, no customer identifier in the phase-0 schema.
  carts: { kind: 'no-pii' },
  cart_items: { kind: 'no-pii' },
  // orders/order_items: no customer columns in phase 0. Phase 1 adds the customer, address and buyer_key
  // columns and MUST replace this with a 'customer-pii' scrub entry (orders stay, identity goes).
  orders: { kind: 'no-pii' },
  order_items: { kind: 'no-pii' },
};

export const classifiedTables = (): string[] => Object.keys(STORE_DO_REGISTRY);
export const unclassifiedTables = (): string[] =>
  STORE_TABLES.filter(t => !(t in STORE_DO_REGISTRY));
