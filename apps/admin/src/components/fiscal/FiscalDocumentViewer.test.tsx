// @vitest-environment jsdom
/** The fiscal document iframe is sandboxed: no scripts ever, so the response CSP not applying to srcDoc does not matter. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock('@/i18n/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('@/components/ui/Button', () => ({
  Button: (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...p} />,
}));
vi.mock('../../lib/api', () => ({
  apiFetch: async () => ({ ok: true, text: async () => '<p>doc</p><script>alert(1)</script>' }),
}));

import { FiscalDocumentViewer } from './FiscalDocumentViewer';

afterEach(cleanup);

describe('FiscalDocumentViewer iframe', () => {
  it('is sandboxed without allow-scripts', async () => {
    const { container } = render(<FiscalDocumentViewer endpoint="/x" backHref="/y" />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const tokens = (container.querySelector('iframe')!.getAttribute('sandbox') ?? '').split(/\s+/);
    expect(container.querySelector('iframe')!.hasAttribute('sandbox')).toBe(true);
    expect(tokens).not.toContain('allow-scripts');
    expect(tokens.sort()).toEqual(['allow-modals', 'allow-same-origin']);
  });
});
