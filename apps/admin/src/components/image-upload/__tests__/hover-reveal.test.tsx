// @vitest-environment jsdom
/**
 * Issue #1356 — the remove/reorder controls on UploadPreview and
 * MultiImageGrid must reveal on HOVER CAPABILITY (`(hover: hover) and
 * (pointer: fine)`), not on a `md:` (768px) viewport-width breakpoint. A
 * touch-only tablet (iPad, >=768px) is a realistic device for a Kuwait
 * merchant editing product images and was left with these controls
 * permanently invisible under the width-based gate. This test pins the
 * class-name contract: no viewport-width opacity gating anywhere on these
 * controls, and the capability-gated `.hover-reveal`/`.hover-reveal-scrim`
 * utilities (globals.css) applied instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UploadPreview } from '../UploadPreview';
import { MultiImageGrid } from '../MultiImageGrid';

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { has: () => true });
  return {
    useTranslations: () => t,
    useLocale: () => 'en',
  };
});

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: Record<string, unknown>) => <img alt="" {...props} />,
}));

afterEach(cleanup);

describe('UploadPreview hover-reveal (#1356)', () => {
  it('gates the remove button on hover capability, not viewport width', () => {
    render(<UploadPreview value="/x.png" alt="x" onRemove={() => {}} />);
    const button = screen.getByRole('button');
    expect(button.className).not.toMatch(/\bmd:opacity-0\b/);
    expect(button.className).not.toMatch(/\bmd:group-hover:opacity-100\b/);
    expect(button.className).toMatch(/\bhover-reveal\b/);
  });
});

describe('MultiImageGrid hover-reveal (#1356)', () => {
  it('gates the controls overlay + scrim on hover capability, not viewport width', () => {
    const { container } = render(
      <MultiImageGrid values={['/a.png', '/b.png']} onMove={() => {}} onRemove={() => {}} />
    );
    const overlay = container.querySelector('.absolute.inset-0');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).not.toMatch(/\bmd:opacity-0\b/);
    expect(overlay!.className).not.toMatch(/\bmd:group-hover:opacity-100\b/);
    expect(overlay!.className).not.toMatch(/\bmd:bg-black\/0\b/);
    expect(overlay!.className).not.toMatch(/\bmd:group-hover:bg-black\/30\b/);
    expect(overlay!.className).toMatch(/\bhover-reveal\b/);
    expect(overlay!.className).toMatch(/\bhover-reveal-scrim\b/);
  });
});
