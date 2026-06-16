/**
 * Barcode Scan-to-Pick — State Transitions Unit Tests
 *
 * Validates the pick state machine logic at the domain level:
 *   unpicked (pickedQty = 0) → partial → fully picked (pickedQty = quantity)
 *
 * Does not mock DB — tests pure business logic functions extracted
 * from the barcode-scan service.
 */

import { describe, it, expect } from 'vitest';

// ─── Domain helpers (extracted from pickOrderItemByBarcode logic) ─────────────

type PickItem = { quantity: number; pickedQty: number };

function applyPick(item: PickItem, qtyToPick: number): PickItem {
  const newPickedQty = Math.min(item.pickedQty + qtyToPick, item.quantity);
  return { ...item, pickedQty: newPickedQty };
}

function isFullyPicked(item: PickItem): boolean {
  return item.pickedQty >= item.quantity;
}

function isOrderFullyPicked(items: PickItem[]): boolean {
  return items.every(i => i.pickedQty >= i.quantity);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('scan-to-pick state transitions', () => {
  describe('single item', () => {
    it('starts unpicked', () => {
      const item: PickItem = { quantity: 3, pickedQty: 0 };
      expect(isFullyPicked(item)).toBe(false);
    });

    it('increments pickedQty by qtyToPick', () => {
      const item: PickItem = { quantity: 3, pickedQty: 0 };
      const updated = applyPick(item, 1);
      expect(updated.pickedQty).toBe(1);
    });

    it('reaches fully-picked when pickedQty equals quantity', () => {
      const item: PickItem = { quantity: 3, pickedQty: 2 };
      const updated = applyPick(item, 1);
      expect(isFullyPicked(updated)).toBe(true);
    });

    it('caps at quantity — scanning extra units does not exceed quantity', () => {
      const item: PickItem = { quantity: 3, pickedQty: 2 };
      // Operator accidentally scans 5 more
      const updated = applyPick(item, 5);
      expect(updated.pickedQty).toBe(3);
    });

    it('remains partially picked when pickedQty < quantity', () => {
      const item: PickItem = { quantity: 5, pickedQty: 3 };
      expect(isFullyPicked(item)).toBe(false);
    });
  });

  describe('order-level pick completion', () => {
    it('order is not fully picked when any item is partial', () => {
      const items: PickItem[] = [
        { quantity: 2, pickedQty: 2 }, // done
        { quantity: 3, pickedQty: 1 }, // partial
      ];
      expect(isOrderFullyPicked(items)).toBe(false);
    });

    it('order is fully picked when all items are picked', () => {
      const items: PickItem[] = [
        { quantity: 2, pickedQty: 2 },
        { quantity: 3, pickedQty: 3 },
      ];
      expect(isOrderFullyPicked(items)).toBe(true);
    });

    it('order with zero items is considered fully picked', () => {
      expect(isOrderFullyPicked([])).toBe(true);
    });

    it('picking the last partial item completes the order', () => {
      const items: PickItem[] = [
        { quantity: 2, pickedQty: 2 },
        { quantity: 3, pickedQty: 2 }, // one remaining
      ];
      const updatedItems = items.map((item, i) => (i === 1 ? applyPick(item, 1) : item));
      expect(isOrderFullyPicked(updatedItems)).toBe(true);
    });
  });

  describe('multi-quantity pick', () => {
    it('can pick more than 1 unit at once', () => {
      const item: PickItem = { quantity: 10, pickedQty: 0 };
      const updated = applyPick(item, 5);
      expect(updated.pickedQty).toBe(5);
      expect(isFullyPicked(updated)).toBe(false);
    });

    it('picking a full quantity in one scan completes the item', () => {
      const item: PickItem = { quantity: 5, pickedQty: 0 };
      const updated = applyPick(item, 5);
      expect(isFullyPicked(updated)).toBe(true);
    });
  });
});
