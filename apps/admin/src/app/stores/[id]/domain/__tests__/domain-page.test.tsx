// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import ar from '@/i18n/messages/ar.json';
import en from '@/i18n/messages/en.json';

const lookup = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], o) as string;
vi.mock('@/i18n/useT', () => ({
  useT: (ns: string) => (k: string, v?: Record<string, string>) => {
    const s = lookup(ar, `${ns}.${k}`) ?? `${ns}.${k}`;
    return v ? s.replace(/\{(\w+)\}/g, (_m, n) => v[n]) : s;
  },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('@ebda/ui', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Input: (p: React.InputHTMLAttributes<HTMLInputElement>) => <input {...p} />,
  Label: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
}));
vi.mock('@/components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/Alert', () => ({
  Alert: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <b>{title}</b>
      {children}
    </div>
  ),
}));
vi.mock('@/components/mobile/DataTable', () => ({
  DataTable: ({ rows }: { rows: Array<{ type: string; name: string; value: string }> }) => (
    <ul>
      {rows.map((r, i) => (
        <li key={i}>{`${r.type} ${r.name} ${r.value}`}</li>
      ))}
    </ul>
  ),
}));
vi.mock('@/hooks/useConfirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(async () => ({
    data: {
      domain: 'ameliaaurum.com',
      verified: false,
      misconfigured: true,
      claimStatus: 'pending',
      dnsRecords: [{ type: 'CNAME', name: 'ameliaaurum.com', value: 'cf.ebda.app' }],
    },
  })),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));
const store = {
  id: 'store-1',
  name: 'Amelia Aurum',
  slug: 'amelia',
  domain: null,
  pendingDomain: 'ameliaaurum.com',
  domainStatus: 'pending',
};
vi.mock('@/hooks/useCurrentStore', () => ({
  useCurrentStore: () => ({ store, isLoading: false, error: null, refetch: vi.fn() }),
}));

import StoreDomainPage from '../page';

afterEach(cleanup);

describe('admin domain page: pending claim', () => {
  it('shows the pending domain, its DNS records and status, never "no custom domain"', async () => {
    render(<StoreDomainPage />);
    await waitFor(() =>
      expect(screen.getByText(/CNAME ameliaaurum\.com cf\.ebda\.app/)).toBeTruthy()
    );
    expect(screen.getAllByText(/ameliaaurum\.com/).length).toBeGreaterThan(0);
    expect(screen.queryByText(ar.domain.page.noDomain)).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('ameliaaurum.com');
  });
});

describe('domain page title word order', () => {
  it('Arabic puts the noun first: «نطاق Amelia Aurum»', () => {
    const s = ar.domain.page.storeDomainTitle.replace('{name}', 'Amelia Aurum');
    expect(s).toBe('نطاق Amelia Aurum');
    expect(s).not.toMatch(/^Amelia Aurum/);
  });
  it('English keeps «Amelia Aurum domain»', () => {
    expect(en.domain.page.storeDomainTitle.replace('{name}', 'Amelia Aurum')).toBe(
      'Amelia Aurum domain'
    );
  });
  it('the old name+suffix concatenation key is gone', () => {
    expect((ar.domain.page as Record<string, string>).storeDomainSuffix).toBeUndefined();
  });
});
