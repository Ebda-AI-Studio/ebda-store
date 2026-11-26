// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

vi.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => (props: { slug: string }) =>
    React.createElement('div', { 'data-testid': 'quick-view' }, props.slug),
}));
let lang: 'en' | 'ar' = 'en';
vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: lang }),
}));
let enabled = true;
vi.mock('@/contexts/FeatureContext', () => ({
  useFeatures: () => ({ isEnabled: () => enabled }),
}));

import { Model3dChip } from './Model3dChip';

afterEach(() => {
  cleanup();
  lang = 'en';
  enabled = true;
});

const p = { slug: 'ring', name: 'Ring', nameAr: 'خاتم' };

describe('Model3dChip', () => {
  it('renders nothing for a product without a model', () => {
    const { container } = render(<Model3dChip product={{ ...p, has3d: false }} />);
    expect(container.innerHTML).toBe('');
    cleanup();
    expect(render(<Model3dChip product={p} />).container.innerHTML).toBe('');
  });
  it('renders nothing when the store lacks product_3d', () => {
    enabled = false;
    expect(render(<Model3dChip product={{ ...p, has3d: true }} />).container.innerHTML).toBe('');
  });
  it('shows the chip with a localized accessible name', () => {
    render(<Model3dChip product={{ ...p, has3d: true }} />);
    expect(screen.getByTestId('model3d-chip').textContent).toContain('3D');
    expect(screen.getByText('3D model')).toBeTruthy();
    cleanup();
    lang = 'ar';
    render(<Model3dChip product={{ ...p, has3d: true }} />);
    expect(screen.getByText('موديل 3D')).toBeTruthy();
  });
  it('a tap opens the quick view and cancels the surrounding link navigation', () => {
    const onLinkClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <div role="link" tabIndex={0} onClick={onLinkClick}>
        <Model3dChip product={{ ...p, has3d: true }} />
      </div>
    );
    expect(screen.queryByTestId('quick-view')).toBeNull();
    fireEvent.click(screen.getByTestId('model3d-chip'));
    expect(screen.getByTestId('quick-view').textContent).toBe('ring');
    expect(onLinkClick).not.toHaveBeenCalled();
  });
});
