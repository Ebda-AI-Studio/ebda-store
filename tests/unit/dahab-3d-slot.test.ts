// Phase B5 Task 2 (finding): the Dahab branch of ProductDetailClient never passed `mediaSlot`, so a
// Dahab product with a 3D model showed no viewer. The slot now carries the same toggle + panel the
// default PDP renders, behind the same `model3d` gate (which already folds in `product_3d`), and a
// product without a model renders nothing (unfilled features render nothing).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(
  path.resolve(__dirname, '../../apps/web/src/app/products/[slug]/ProductDetailClient.tsx'),
  'utf8'
);
const branch = src.slice(src.indexOf("if (templateId === 'dahab')"));
const slot = branch.slice(
  branch.indexOf('mediaSlot={'),
  branch.indexOf('selectedImage={selectedImage}')
);

describe('Dahab PDP 3D slot', () => {
  it('the dahab branch passes a mediaSlot', () => {
    expect(branch).toContain('mediaSlot={');
  });
  it('it is gated on the same model3d value as the default PDP, and is undefined without a model', () => {
    expect(src).toMatch(/const model3d = product\?\.model3d && isEnabled\('product_3d'\)/);
    expect(slot).toMatch(/model3d \? \(/);
    expect(slot).toMatch(/\) : undefined/);
  });
  it('it renders the toggle and the panel, and keeps the analytics event', () => {
    expect(slot).toContain('<Model3dToggle');
    expect(slot).toContain('<ProductModel3dPanel');
    expect(slot).toContain("captureEvent('product_3d_opened'");
  });
  it('the toggle is a 44px target (quality bar section 10)', () => {
    const toggle = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/components/ProductModel3d.tsx'),
      'utf8'
    );
    expect(toggle).toMatch(/inline-flex h-11 items-center/);
  });
  it('the slot renders under the gallery in the Dahab layout', () => {
    const pd = readFileSync(
      path.resolve(__dirname, '../../apps/web/src/templates/dahab/ProductDetail.tsx'),
      'utf8'
    );
    expect(pd).toMatch(/<\/Gallery>|\/>\s*\{p\.mediaSlot\}/);
  });
});
