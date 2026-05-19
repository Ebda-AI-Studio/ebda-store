'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { useT } from '@/i18n/useT';
import { apiGet } from '@/lib/api';

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

  useEffect(() => {
    if (!storeId) return;
    apiGet<AccountsTree>(`/api/v1/stores/${storeId}/finance/accounts`)
      .then(({ data, error: apiError }) => {
        if (apiError) {
          setError(apiError.message);
        } else if (data) {
          setTree(data);
        }
      })
      .catch(() => setError('Failed to load chart of accounts'));
  }, [storeId]);

  if (error) {
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

  const total = GROUPS.reduce((sum, g) => sum + (tree[g.key]?.length ?? 0), 0);

  return (
    <AdminLayout title={t('title')} subtitle={t('description')}>
      <div className="max-w-4xl space-y-6">
        {total === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noAccountsHint')}</p>
        ) : (
          GROUPS.map(({ key, typeKey }) => {
            const rows = flattenTree(tree[key] ?? []);
            if (rows.length === 0) return null;
            return (
              <section key={key}>
                <h2 className="text-base font-semibold mb-2">{t(`type.${typeKey}`)}</h2>
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="text-start px-3 py-2 w-24 font-medium text-muted-foreground">
                          {t('code')}
                        </th>
                        <th className="text-start px-3 py-2 font-medium text-muted-foreground">
                          {t('name')}
                        </th>
                        <th className="text-end px-3 py-2 w-24 font-medium text-muted-foreground">
                          {t('system')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ node, depth }) => (
                        <tr key={node.id} className="border-t border-border/40">
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                            {node.code}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              style={{ paddingInlineStart: `${depth * 1.25}rem` }}
                              className="block"
                            >
                              {node.nameEn}
                              {node.nameAr ? (
                                <span className="text-muted-foreground ms-2 text-xs" dir="rtl">
                                  — {node.nameAr}
                                </span>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-end text-muted-foreground">
                            {node.isSystem ? '✓' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })
        )}
      </div>
    </AdminLayout>
  );
}
