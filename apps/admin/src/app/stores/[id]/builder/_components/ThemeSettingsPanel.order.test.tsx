// @vitest-environment jsdom
/**
 * Task 10 (EP Task 5): the theme pane reads top to bottom like the storefront (the header first),
 * offers the header chrome controls only to the skins that read them (Ruling EP-1), and a stored
 * override shows as edited with a way back to the look (Ruling EP-4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getLook } from '@ebda/shared';

vi.mock('../../../../../lib/api', () => ({
  apiPut: vi.fn(),
  apiPost: vi.fn(),
  apiGet: vi.fn(),
  apiFetch: vi.fn(),
  localizedApiMessage: (_c: unknown, m: string) => m,
}));
vi.mock('next-intl', () => ({ useLocale: () => 'en' }));
vi.mock('@/i18n/useT', () => ({
  useT: () =>
    Object.assign(
      (key: string, p?: Record<string, string>) =>
        p ? `${key} ${Object.values(p).join(' ')}` : key,
      { has: () => true }
    ),
}));

import { ThemeSettingsPanel } from './ThemeSettingsPanel';

const legends = () =>
  [...document.querySelectorAll('[data-testid^="tier2-"] > summary')].map(l =>
    l.textContent?.trim()
  );
afterEach(cleanup);

describe('ThemeSettingsPanel order and header controls', () => {
  it('Qamar: the Header group comes first, with the logo position only', () => {
    render(
      <ThemeSettingsPanel
        theme={undefined}
        storeTemplate="qamar"
        look={getLook('qamar.atelier')}
        onSave={async () => true}
      />
    );
    expect(legends()[0]).toBe('tier.header');
    expect(legends().indexOf('tier.header')).toBeLessThan(legends().indexOf('tier.colors'));
    expect(document.querySelector('[data-setting-id="builder.header-logo"]')).not.toBeNull();
    expect(document.querySelector('[data-setting-id="builder.header-search"]')).toBeNull();
  });

  it('Souq: logo position and search placement', () => {
    render(
      <ThemeSettingsPanel
        theme={undefined}
        storeTemplate="souq"
        look={getLook('souq.catalogue')}
        onSave={async () => true}
      />
    );
    expect(document.querySelector('[data-setting-id="builder.header-search"]')).not.toBeNull();
  });

  it('a skin that draws its own header gets only the controls it reads (the wordmark), and the rest stays', () => {
    render(
      <ThemeSettingsPanel theme={undefined} storeTemplate="dahab" onSave={async () => true} />
    );
    expect(legends()[0]).toBe('tier.header');
    expect(document.querySelector('[data-setting-id="builder.header-logo"]')).toBeNull();
    expect(document.querySelector('[data-setting-id="builder.header-search"]')).toBeNull();
    expect(document.querySelector('[data-setting-id="builder.header-wordmark"]')).not.toBeNull();
    expect(legends()[1]).toBe('tier.cards');
  });

  it('choosing a placement saves it as a draft theme patch', async () => {
    const onSave = vi.fn(async () => true);
    render(
      <ThemeSettingsPanel
        theme={undefined}
        storeTemplate="qamar"
        look={getLook('qamar.atelier')}
        onSave={onSave}
      />
    );
    const select = document.querySelector(
      '[data-setting-id="builder.header-logo"] select'
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'centre' } });
    fireEvent.click(screen.getByText('save'));
    expect(onSave).toHaveBeenCalledWith({ headerLogoPlacement: 'centre' });
  });

  it('an unset override shows "inherit" instead of the first option, a stored one shows its value', () => {
    const mount = (theme: never) =>
      render(
        <ThemeSettingsPanel
          theme={theme}
          storeTemplate="qamar"
          look={getLook('qamar.atelier')}
          onSave={async () => true}
        />
      );
    const sel = () =>
      document.querySelector('[data-setting-id="builder.header-logo"] select') as HTMLSelectElement;
    const first = mount(undefined as never);
    expect(sel().value).toBe('');
    expect(sel().querySelector('option[value=""]')?.textContent).toBe('inherit');
    first.unmount();
    mount({ headerLogoPlacement: 'centre' } as never);
    expect(sel().value).toBe('centre');
    expect(sel().querySelector('option[value=""]')).toBeNull();
  });

  it('a stored override is marked edited and can be reset to the look', () => {
    const onResetKey = vi.fn(async () => true);
    render(
      <ThemeSettingsPanel
        theme={{ headerLogoPlacement: 'centre' } as never}
        storeTemplate="qamar"
        look={getLook('qamar.atelier')}
        onResetKey={onResetKey}
        onSave={async () => true}
      />
    );
    const row = document.querySelector('[data-setting-id="builder.header-logo"]')!;
    expect(row.textContent).toContain('edited');
    fireEvent.click(row.querySelector('button')!);
    expect(onResetKey).toHaveBeenCalledWith('headerLogoPlacement');
  });

  it('the wordmark control shows the look value until picked; a pick saves a draft patch and can be reset', () => {
    const onSave = vi.fn(async () => true);
    const onResetKey = vi.fn(async () => true);
    const { unmount } = render(
      <ThemeSettingsPanel
        theme={undefined}
        storeTemplate="qamar"
        look={getLook('qamar.atelier')}
        onSave={onSave}
        onResetKey={onResetKey}
      />
    );
    const sel = () =>
      document.querySelector(
        '[data-setting-id="builder.header-wordmark"] select'
      ) as HTMLSelectElement;
    expect(sel().value).toBe('lockup'); // the look's own value, not an empty "inherit"
    fireEvent.change(sel(), { target: { value: 'plain' } });
    fireEvent.click(screen.getByText('save'));
    expect(onSave).toHaveBeenCalledWith({ headerWordmark: 'plain' });
    unmount();
    render(
      <ThemeSettingsPanel
        theme={{ headerWordmark: 'plain' } as never}
        storeTemplate="qamar"
        look={getLook('qamar.atelier')}
        onSave={onSave}
        onResetKey={onResetKey}
      />
    );
    const row = document.querySelector('[data-setting-id="builder.header-wordmark"]')!;
    expect(sel().value).toBe('plain');
    expect(row.textContent).toContain('edited');
    fireEvent.click(row.querySelector('button')!);
    expect(onResetKey).toHaveBeenCalledWith('headerWordmark');
  });
});
