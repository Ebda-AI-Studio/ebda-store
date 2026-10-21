// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { looksForTemplate } from '@ebda/shared';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

vi.mock('../../../../lib/api', () => ({ apiGet, apiPut }));
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'store-1' }) }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@ebda/ui', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));
vi.mock('../../../../components/AdminLayout', () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../../components/AdminSkeleton', () => ({ AdminSkeletonDetail: () => null }));

import StoreTemplatePage from './page';

const looks = looksForTemplate('dahab');
const target = looks[1]!;

function storeWith(look: string | null, template = 'modern') {
  apiGet.mockResolvedValue({ data: { store: { name: 'S', template, look } } });
}

async function pickTarget() {
  // The picker opens on the first template with a built look (Qamar, B1-19): go to Dahab's tab.
  fireEvent.click(await screen.findByRole('tab', { name: 'Dahab' }));
  const card = await screen.findByRole('radio', { name: new RegExp(target.name.en) });
  fireEvent.click(card);
}

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
});
afterEach(cleanup);

describe('template page (looks)', () => {
  it('does not offer the legacy skins and shows the current legacy skin when look is null', async () => {
    storeWith(null, 'classic');
    render(<StoreTemplatePage />);
    await screen.findAllByRole('tab');
    expect(screen.queryByText('Elegant')).toBeNull();
    expect(screen.getByTestId('legacy-skin').textContent).toContain('skins.classic');
    expect(screen.getByText('legacyNote')).toBeTruthy();
  });

  it('a stored look id that is not registered renders as "choose a look", without crashing', async () => {
    storeWith('qamar.removed', 'minimal');
    render(<StoreTemplatePage />);
    await screen.findAllByRole('tab');
    // Treated exactly like a legacy store: the current skin + the "pick a look" note, no look selected.
    expect(screen.getByTestId('legacy-skin').textContent).toContain('skins.minimal');
    expect(screen.getByText('legacyNote')).toBeTruthy();
    for (const radio of screen.getAllByRole('radio'))
      expect(radio.getAttribute('aria-checked')).not.toBe('true');
    await pickTarget();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('choosing a look opens a labelled dialog with keep selected by default', async () => {
    storeWith(null);
    render(<StoreTemplatePage />);
    await pickTarget();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect((screen.getByLabelText('keep') as HTMLInputElement).checked).toBe(true);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('Escape closes the dialog without saving', async () => {
    storeWith(null);
    render(<StoreTemplatePage />);
    await pickTarget();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('keep sends design keep; a draft result shows the editor link', async () => {
    storeWith(null);
    apiPut.mockResolvedValue({
      data: { look: target.id, template: 'dahab', builder: 'draft' },
    });
    render(<StoreTemplatePage />);
    await pickTarget();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/look', {
        lookId: target.id,
        design: 'keep',
      })
    );
    expect(await screen.findByText('draftReady')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'openBuilder' }).getAttribute('href')).toBe(
      '/stores/store-1/builder'
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('start fresh sends design reset; a published result shows the short success line', async () => {
    storeWith(target.id === looks[0]!.id ? looks[2]!.id : looks[0]!.id);
    apiPut.mockResolvedValue({
      data: { look: target.id, template: 'dahab', builder: 'published' },
    });
    render(<StoreTemplatePage />);
    await pickTarget();
    fireEvent.click(screen.getByLabelText('reset'));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/api/v1/stores/store-1/look', {
        lookId: target.id,
        design: 'reset',
      })
    );
    expect(await screen.findByText('published')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'openBuilder' })).toBeNull();
  });

  it('keeps the dialog open and shows an error when the save fails', async () => {
    storeWith(null);
    apiPut.mockResolvedValue({ error: { code: 'NETWORK', message: 'boom' } });
    render(<StoreTemplatePage />);
    await pickTarget();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('saveError');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('maps INVALID_LOOK to its own message', async () => {
    storeWith(null);
    apiPut.mockResolvedValue({ error: { code: 'INVALID_LOOK', message: 'bad' } });
    render(<StoreTemplatePage />);
    await pickTarget();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('invalidLook');
  });
});
