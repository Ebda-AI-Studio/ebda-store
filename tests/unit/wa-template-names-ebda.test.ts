/**
 * WhatsApp template names are `ebda_<purpose>_v<n>` (never `force_`), same versions and variables.
 * A store still approved under an old `force_*` name keeps sending under it until the new name is
 * approved for that store (explicit old → new fallback).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const db = vi.hoisted(() => ({
  rows: [] as Array<{ metaName: string; language: string; status: string }>,
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    whatsAppTemplate: {
      // honours the where clause the way Postgres would
      findMany: async ({
        where,
      }: {
        where: { status: string; metaName: string; language: string };
      }) =>
        db.rows.filter(
          r =>
            r.status === where.status &&
            r.metaName === where.metaName &&
            r.language === where.language
        ),
    },
  },
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { TEMPLATES } from '@api/lib/wa-templates/definitions';
import { buildTemplatesForStore } from '@api/lib/wa-templates/buildForStore';
import {
  LEGACY_TEMPLATE_NAMES,
  pickSendTemplateName,
  resolveSendTemplateName,
} from '@api/lib/wa-templates/legacy-names';

const NEW_NAMES = [
  'ebda_order_paid_v1',
  'ebda_order_shipped_v2',
  'ebda_order_delivered_v2',
  'ebda_welcome_back_v1',
  'ebda_cart_abandoned_v1',
  'ebda_payment_link_v1',
];

describe('canonical WhatsApp template names', () => {
  it('are exactly the six ebda_* names (en + ar), same versions', () => {
    expect([...new Set(TEMPLATES.map(t => t.name))].sort()).toEqual([...NEW_NAMES].sort());
    expect(TEMPLATES).toHaveLength(12);
  });

  it('variables are unchanged: counts per template', () => {
    const counts = Object.fromEntries(TEMPLATES.map(t => [t.name, t.variableCount]));
    expect(counts).toEqual({
      ebda_order_paid_v1: 4,
      ebda_order_shipped_v2: 5,
      ebda_order_delivered_v2: 4,
      ebda_welcome_back_v1: 2,
      ebda_cart_abandoned_v1: 3,
      ebda_payment_link_v1: 5,
    });
  });

  it('the per-store Meta name is still <slug>_<purpose>_v<n>', () => {
    const names = buildTemplatesForStore({ slug: 'wady-aljuz', name: 'W', nameAr: null }).map(
      t => t.name
    );
    expect(names).toContain('wady_aljuz_order_paid_v1');
    expect(names.some(n => n.startsWith('ebda_') || n.startsWith('force_'))).toBe(false);
  });

  it('no force_ template name is left in code or docs outside the legacy map', () => {
    const root = join(__dirname, '../..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        if (['node_modules', 'dist', '.next', 'graphify-out', '.git', 'plans'].includes(n))
          continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|md|mdx|json)$/.test(n)) {
          const rel = relative(root, p);
          if (rel.endsWith('legacy-names.ts') || rel.endsWith('wa-template-names-ebda.test.ts'))
            continue;
          if (/\bforce_(order|welcome|cart|payment)_[a-z_]*v\d/.test(readFileSync(p, 'utf8')))
            hits.push(rel);
        }
      }
    };
    for (const d of ['apps', 'packages', 'docs', 'tests']) walk(join(root, d));
    expect(hits).toEqual([]);
  });
});

describe('old name → new name fallback at send time', () => {
  it('every legacy name maps to a real canonical name', () => {
    expect(Object.values(LEGACY_TEMPLATE_NAMES).sort()).toEqual([...NEW_NAMES].sort());
  });

  it('a store still approved under the old name keeps sending under it', () => {
    expect(pickSendTemplateName('force_order_paid_v1', new Set())).toBe('force_order_paid_v1');
    expect(pickSendTemplateName('force_order_paid_v1', new Set(['force_order_paid_v1']))).toBe(
      'force_order_paid_v1'
    );
  });

  it('once the new name is approved for the store, the new name is used', () => {
    expect(pickSendTemplateName('force_order_shipped_v2', new Set(['ebda_order_shipped_v2']))).toBe(
      'ebda_order_shipped_v2'
    );
  });

  it('a new or per-store name is never touched', () => {
    expect(pickSendTemplateName('ebda_order_paid_v1', new Set())).toBe('ebda_order_paid_v1');
    expect(pickSendTemplateName('wady_aljuz_order_paid_v1', new Set(['x']))).toBe(
      'wady_aljuz_order_paid_v1'
    );
  });
});

describe('the fallback checks approval per language', () => {
  it('en approved under ebda_*, ar not: an ar send keeps the old name', async () => {
    db.rows = [{ metaName: 'ebda_order_paid_v1', language: 'en', status: 'approved' }];
    expect(await resolveSendTemplateName('s1', 'force_order_paid_v1', 'ar')).toBe(
      'force_order_paid_v1'
    );
    expect(await resolveSendTemplateName('s1', 'force_order_paid_v1', 'en')).toBe(
      'ebda_order_paid_v1'
    );
  });

  it('both languages approved: both switch; a draft row never counts', async () => {
    db.rows = [
      { metaName: 'ebda_order_paid_v1', language: 'en', status: 'approved' },
      { metaName: 'ebda_order_paid_v1', language: 'ar', status: 'approved' },
    ];
    expect(await resolveSendTemplateName('s1', 'force_order_paid_v1', 'ar')).toBe(
      'ebda_order_paid_v1'
    );
    db.rows = [{ metaName: 'ebda_order_paid_v1', language: 'ar', status: 'draft' }];
    expect(await resolveSendTemplateName('s1', 'force_order_paid_v1', 'ar')).toBe(
      'force_order_paid_v1'
    );
  });
});
