'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';

import { Button } from '@/components/ui/Button';
import { FIELD_CLASSES } from '@/components/ui/tokens';
// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountNode {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isSystem: boolean;
  isActive: boolean;
  children: AccountNode[];
}

interface AccountsTree {
  assets: AccountNode[];
  liabilities: AccountNode[];
  equity: AccountNode[];
  revenue: AccountNode[];
  expenses: AccountNode[];
}

interface AccountTreeRow {
  node: AccountNode;
  depth: number;
}

const GROUPS: { key: keyof AccountsTree; typeKey: string }[] = [
  { key: 'assets', typeKey: 'asset' },
  { key: 'liabilities', typeKey: 'liability' },
  { key: 'equity', typeKey: 'equity' },
  { key: 'revenue', typeKey: 'revenue' },
  { key: 'expenses', typeKey: 'expense' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Flatten a nested tree node array into a depth-annotated list for table rendering. */
function flattenTree(nodes: AccountNode[], depth = 0): { node: AccountNode; depth: number }[] {
  const result: { node: AccountNode; depth: number }[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children, depth + 1));
    }
  }
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AccountsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('finance.accounts');
  const tc = useT('common');

  const [tree, setTree] = useState<AccountsTree | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed-COA state
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);

  // Create-custom-account form state
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [form, setForm] = useState({ parentId: '', code: '', nameEn: '', nameAr: '' });

  function loadTree() {
    if (!storeId) return;
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data) {
          setError(null);
          setTree(data);
        }
      })
      .catch(() => setError(t('loadFailed')));
  }

  useEffect(() => {
    loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  // System (top-level) accounts are the only valid parents for a custom child.
  const parentOptions = useMemo(() => {
    if (!tree) return [];
    const opts: { id: string; code: string; nameEn: string }[] = [];
    for (const { key } of GROUPS) {
      for (const node of tree[key] ?? []) {
        if (node.isSystem) opts.push({ id: node.id, code: node.code, nameEn: node.nameEn });
      }
    }
    return opts;
  }, [tree]);

  async function handleSeed() {
    setSeeding(true);
    setSeedMsg(null);
    const { data, error: apiError } = await apiPost<{ created: number }>(
      `/api/v1/stores/${storeId}/finance/accounts/seed`,
      {}
    );
    setSeeding(false);
    if (apiError) {
      setSeedMsg(null);
      setError(apiError.message || t('seedError'));
      return;
    }
    setSeedMsg(t('seedSuccess', { count: data?.created ?? 0 }));
    loadTree();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateErr(null);
    const { error: apiError } = await apiPost(`/api/v1/stores/${storeId}/finance/accounts`, {
      parentId: form.parentId,
      code: form.code,
      nameEn: form.nameEn,
      nameAr: form.nameAr || undefined,
    });
    setCreating(false);
    if (apiError) {
      setCreateErr(apiError.message || t('createError'));
      return;
    }
    setForm({ parentId: '', code: '', nameEn: '', nameAr: '' });
    setShowCreate(false);
    loadTree();
  }

  const total = tree ? GROUPS.reduce((sum, g) => sum + (tree[g.key]?.length ?? 0), 0) : 0;

  const accountColumns: DataTableColumn<AccountTreeRow>[] = [
    {
      header: t('code'),
      className: 'w-24',
      cell: ({ node }) => (
        <span className="font-mono text-xs text-muted-foreground">{node.code}</span>
      ),
    },
    {
      header: t('name'),
      primaryOnMobile: true,
      cell: ({ node, depth }) => (
        <span style={{ paddingInlineStart: `${depth * 1.25}rem` }} className="block">
          {node.nameEn}
          {node.nameAr ? (
            <span className="text-muted-foreground ms-2 text-xs" dir="rtl">
              — {node.nameAr}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      header: t('system'),
      alignEnd: true,
      mobileBadge: true,
      className: 'w-24',
      cell: ({ node }) => <span className="text-muted-foreground">{node.isSystem ? '✓' : ''}</span>,
    },
  ];

  if (error && !tree) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-red-600 text-sm">{error}</div>
      </AdminLayout>
    );
  }

  if (!tree) {
    return (
      <AdminLayout title={t('title')}>
        <div className="p-6 text-muted-foreground text-sm">{tc('loading')}</div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-4xl space-y-6">
        {/* Actions: seed COA + add custom account */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={handleSeed} disabled={seeding} variant="default">
            {seeding ? t('seeding') : t('seedButton')}
          </Button>
          {total > 0 && parentOptions.length > 0 && (
            <Button type="button" onClick={() => setShowCreate(v => !v)} variant="outline">
              {t('createButton')}
            </Button>
          )}
        </div>

        {seedMsg && <p className="text-sm text-emerald-600">{seedMsg}</p>}
        {error && <p className="text-red-600 text-sm">{error}</p>}

        {/* Create custom account form */}
        {showCreate && parentOptions.length > 0 && (
          <form
            onSubmit={handleCreate}
            className="space-y-3 rounded-xl border border-border bg-muted/20 p-4"
          >
            <h2 className="text-base font-semibold">{t('createTitle')}</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('fieldParent')}</span>
                <select
                  required
                  value={form.parentId}
                  onChange={e => setForm(f => ({ ...f, parentId: e.target.value }))}
                  className={FIELD_CLASSES}
                >
                  <option value="">{t('selectParent')}</option>
                  {parentOptions.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.nameEn}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('fieldCode')}</span>
                <input
                  required
                  value={form.code}
                  onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                  placeholder="5210"
                  pattern="\d{4,6}"
                  className={`${FIELD_CLASSES} font-mono`}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('fieldNameEn')}</span>
                <input
                  required
                  value={form.nameEn}
                  onChange={e => setForm(f => ({ ...f, nameEn: e.target.value }))}
                  className={FIELD_CLASSES}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t('fieldNameAr')}</span>
                <input
                  value={form.nameAr}
                  onChange={e => setForm(f => ({ ...f, nameAr: e.target.value }))}
                  dir="rtl"
                  className={FIELD_CLASSES}
                />
              </label>
            </div>
            {createErr && <p className="text-red-600 text-sm">{createErr}</p>}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={creating} variant="default">
                {creating ? t('creating') : t('createSubmit')}
              </Button>
              <Button type="button" onClick={() => setShowCreate(false)} variant="outline">
                {t('cancel')}
              </Button>
            </div>
          </form>
        )}

        {/* COA tree */}
        {total === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noAccountsHint')}</p>
        ) : (
          GROUPS.map(({ key, typeKey }) => {
            const rows = flattenTree(tree[key] ?? []);
            if (rows.length === 0) return null;
            return (
              <section key={key}>
                <h2 className="text-base font-semibold mb-2">{t(`type.${typeKey}`)}</h2>
                <DataTable<AccountTreeRow>
                  ariaLabel={t(`type.${typeKey}`)}
                  columns={accountColumns}
                  rows={rows}
                  rowKey={({ node }) => node.id}
                />
              </section>
            );
          })
        )}
      </div>
    </AdminLayout>
  );
}
