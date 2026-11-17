// @vitest-environment jsdom
/**
 * Editor premium F47/F48: the section-tools toolbar name comes from the copy table (no inline
 * `rtl ? ... : ...` strings), and the overlay outlines + chip share one size scale.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { CanvasToolbar } from '../../apps/web/src/builder/preview/CanvasToolbar';
import { chipTopFor } from '../../apps/web/src/builder/preview/EditorOverlay';
import { OVERLAY_SCALE } from '../../apps/web/src/builder/preview/overlay-scale';

afterEach(cleanup);

const props = {
  box: { top: 100, left: 10, width: 300, height: 200 },
  pageWidth: 800,
  draggable: true,
  disabled: {},
  onOp: () => {},
  onDragStart: () => {},
};

describe('CanvasToolbar copy (F47)', () => {
  it('names the toolbar from the copy table in both languages', () => {
    const en = render(<CanvasToolbar locale="en" {...props} />);
    expect(en.getByRole('toolbar').getAttribute('aria-label')).toBe('Section tools');
    en.unmount();
    const ar = render(<CanvasToolbar locale="ar" {...props} />);
    expect(ar.getByRole('toolbar').getAttribute('aria-label')).toBe('أدوات القسم');
  });
  it('has no inline locale ternary string left in the source', () => {
    const src = readFileSync('apps/web/src/builder/preview/CanvasToolbar.tsx', 'utf8');
    expect(src).not.toMatch(/aria-label=\{rtl/);
  });
});

describe('overlay size scale (F48)', () => {
  it('is 2px selected, 1px hover, 24px chip', () => {
    expect(OVERLAY_SCALE).toEqual({ outlineSelected: 2, outlineHover: 1, chip: 24 });
    expect(chipTopFor({ top: 100, height: 50 })).toBe(76);
  });
  it('the source uses the scale, not ad hoc numbers', () => {
    const src = readFileSync('apps/web/src/builder/preview/EditorOverlay.tsx', 'utf8');
    expect(src).toContain('OVERLAY_SCALE.outlineHover');
    expect(src).not.toMatch(/outline: `2px \$\{kind/);
  });
});
