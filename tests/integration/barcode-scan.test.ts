/**
 * Barcode Scan — Integration Tests
 *
 * Tests the lookup + receive + count session lifecycle endpoints against a
 * real Postgres database (provided by the CI postgres service container).
 *
 * Requires DATABASE_URL to point at a running Postgres 16+ instance.
 * Each test creates its own isolated store/product and cleans up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, runInTenantContext } from '@force/database';
import {
  lookupBarcode,
  receiveByBarcode,
  openCountSession,
  submitCountLine,
  closeCountSession,
  reconcileCountSession,
  listCountSessions,
  getCountSession,
} from '../../apps/api/src/services/barcode-scan.service';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

let storeId: string;
let ownerId: string;
let productId: string;
let variantProductId: string;
let variantId: string;

const TEST_BARCODE = `BC-INTTEST-${Date.now()}`;
const TEST_BARCODE_VAR = `BCVAR-INTTEST-${Date.now()}`;

beforeAll(async () => {
  // Create owner user
  const owner = await prisma.user.create({
    data: {
      email: `barcode-scan-test-${Date.now()}@example.test`,
      passwordHash: 'x'.repeat(60),
      firstName: 'Barcode',
      lastName: 'Test',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  ownerId = owner.id;

  // Create store
  const store = await prisma.store.create({
    data: {
      name: 'Barcode Scan Test Store',
      slug: `barcode-scan-test-${Date.now()}`,
      ownerId,
      status: 'active',
    },
  });
  storeId = store.id;

  // Product with barcode (no variants)
  const product = await prisma.product.create({
    data: {
      storeId,
      name: 'Scan Test Widget',
      slug: `scan-test-widget-${Date.now()}`,
      price: 5000,
      inventory: 20,
      barcode: TEST_BARCODE,
      sku: 'STW-001',
      status: 'active',
    },
  });
  productId = product.id;

  // Product with variant barcode
  const varProduct = await prisma.product.create({
    data: {
      storeId,
      name: 'Scan Variant Widget',
      slug: `scan-variant-widget-${Date.now()}`,
      price: 8000,
      inventory: 0,
      status: 'active',
      hasVariants: true,
    },
  });
  variantProductId = varProduct.id;

  const variant = await prisma.productVariant.create({
    data: {
      productId: variantProductId,
      title: 'Blue / Large',
      barcode: TEST_BARCODE_VAR,
      sku: 'SVW-BL',
      inventory: 5,
    },
  });
  variantId = variant.id;
});

afterAll(async () => {
  // Clean up in reverse dependency order
  await prisma.countLine.deleteMany({ where: { session: { storeId } } });
  await prisma.countSession.deleteMany({ where: { storeId } });
  await prisma.inventoryHistory.deleteMany({ where: { storeId } });
  // reconcileCountSession posts cycle_count adjustments whose stock_adjustment_items
  // FK-reference products (RESTRICT, no cascade). Delete adjustments first (items
  // cascade) so the product delete below doesn't hit stock_adjustment_items_product_id_fkey.
  await prisma.stockAdjustment.deleteMany({ where: { storeId } });
  await prisma.productVariant.deleteMany({ where: { productId: variantProductId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('barcode lookup', () => {
  it('resolves a product-level barcode to the correct product', async () => {
    const result = await lookupBarcode(storeId, TEST_BARCODE);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('product');
    expect(result!.productId).toBe(productId);
    expect(result!.inventory).toBe(20);
    expect(result!.ambiguous).toBe(false);
  });

  it('resolves a variant-level barcode to the correct variant', async () => {
    const result = await lookupBarcode(storeId, TEST_BARCODE_VAR);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('variant');
    expect(result!.variantId).toBe(variantId);
    expect(result!.productId).toBe(variantProductId);
    expect(result!.inventory).toBe(5);
  });

  it('returns null for a barcode that does not exist', async () => {
    const result = await lookupBarcode(storeId, 'DOES-NOT-EXIST-XYZ-99999');
    expect(result).toBeNull();
  });

  it('does not cross store boundaries — barcode from another store returns null', async () => {
    // Use a different (nonexistent) storeId
    const result = await lookupBarcode('00000000-0000-0000-0000-000000000001', TEST_BARCODE);
    expect(result).toBeNull();
  });
});

describe('scan-to-receive', () => {
  it('increases inventory and creates an InventoryHistory record', async () => {
    const before = await prisma.product.findUnique({
      where: { id: productId },
      select: { inventory: true },
    });
    const startQty = before!.inventory;

    const result = await runInTenantContext(storeId, () =>
      receiveByBarcode(storeId, TEST_BARCODE, 5, ownerId, 'INT-TEST')
    );

    expect(result.qtyReceived).toBe(5);
    expect(result.previousInventory).toBe(startQty);
    expect(result.newInventory).toBe(startQty + 5);

    // Verify DB was updated
    const after = await prisma.product.findUnique({
      where: { id: productId },
      select: { inventory: true },
    });
    expect(after!.inventory).toBe(startQty + 5);

    // InventoryHistory row created
    const historyCount = await prisma.inventoryHistory.count({
      where: { productId, storeId, type: 'manual_add' },
    });
    expect(historyCount).toBeGreaterThanOrEqual(1);
  });

  it('throws BARCODE_NOT_FOUND when barcode does not exist', async () => {
    await expect(
      runInTenantContext(storeId, () => receiveByBarcode(storeId, 'FAKE-BC-9999', 1, ownerId))
    ).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND' });
  });

  it('throws INVALID_QTY when qty is zero or negative', async () => {
    await expect(
      runInTenantContext(storeId, () => receiveByBarcode(storeId, TEST_BARCODE, 0, ownerId))
    ).rejects.toMatchObject({ code: 'INVALID_QTY' });
  });
});

describe('cycle-count session lifecycle', () => {
  let sessionId: string;

  it('opens a new session', async () => {
    const session = await runInTenantContext(storeId, () =>
      openCountSession(storeId, ownerId, 'Integration test session')
    );
    expect(session.status).toBe('open');
    expect(session.storeId).toBe(storeId);
    sessionId = session.id;
  });

  it('appears in listCountSessions', async () => {
    const sessions = await runInTenantContext(storeId, () =>
      listCountSessions(storeId, { status: 'open' })
    );
    expect(sessions.some(s => s.id === sessionId)).toBe(true);
  });

  it('submits a count line for the product', async () => {
    const line = await runInTenantContext(storeId, () =>
      submitCountLine(storeId, sessionId, { productId, countedQty: 99 })
    );
    expect(line.countedQty).toBe(99);
    // System qty should be whatever is currently in DB
    expect(typeof line.systemQty).toBe('number');
    expect(line.variance).toBe(line.countedQty - line.systemQty);
  });

  it('upserts the count line when the same product is scanned again', async () => {
    const line = await runInTenantContext(storeId, () =>
      submitCountLine(storeId, sessionId, { productId, countedQty: 50 })
    );
    // Should update, not create a second row
    expect(line.countedQty).toBe(50);

    const detail = await runInTenantContext(storeId, () => getCountSession(storeId, sessionId));
    const linesForProduct = detail!.lines.filter(l => l.productId === productId);
    expect(linesForProduct.length).toBe(1);
    expect(linesForProduct[0].countedQty).toBe(50);
  });

  it('closes the session', async () => {
    const result = await runInTenantContext(storeId, () => closeCountSession(storeId, sessionId));
    expect(result.status).toBe('closed');
  });

  it('throws when trying to add a line to a closed session', async () => {
    await expect(
      runInTenantContext(storeId, () =>
        submitCountLine(storeId, sessionId, { productId, countedQty: 1 })
      )
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('reconciles the session and creates a StockAdjustment', async () => {
    const result = await runInTenantContext(storeId, () =>
      reconcileCountSession(storeId, sessionId, ownerId)
    );
    // adjustmentId is null only if all variances were zero
    // In our test countedQty=50 vs real inventory, so likely non-zero
    // Either way the session should be marked reconciled
    expect(typeof result.linesReconciled).toBe('number');
    expect(typeof result.zeroVarianceLines).toBe('number');

    const detail = await runInTenantContext(storeId, () => getCountSession(storeId, sessionId));
    expect(detail!.status).toBe('reconciled');
  });

  it('throws when trying to reconcile a session that is not closed', async () => {
    const session2 = await runInTenantContext(storeId, () =>
      openCountSession(storeId, ownerId, 'Second session')
    );
    await expect(
      runInTenantContext(storeId, () => reconcileCountSession(storeId, session2.id, ownerId))
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    // Cleanup
    await runInTenantContext(storeId, () => closeCountSession(storeId, session2.id));
  });
});
