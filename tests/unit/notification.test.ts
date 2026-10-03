/**
 * Communication Hub — Notification Unit Tests
 * Tests for notification types, templates, and rendering
 */

import { describe, it, expect } from 'vitest';

// Import directly from source (same pattern as feature.test.ts)
import {
  SMS_TEMPLATES,
  PUSH_TEMPLATES,
  renderSmsTemplate,
  type NotificationData,
  type NotificationEvent,
} from '../../packages/shared/src/notifications';

// ─── Sample data ──────────────────────────────────────────────────────────────

const sampleData: NotificationData = {
  customerName: 'Ahmad',
  orderNumber: 'ORD-001',
  total: 25.5,
  amount: 25.5,
  trackingNumber: 'TRK-999',
  reason: 'Out of stock',
  storeId: 'store-1',
  storeName: 'Ebda',
};

// All notification events for iteration
const ALL_EVENTS: NotificationEvent[] = [
  'order_confirmed',
  'payment_success',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'refund_processed',
  'cart_abandoned_step1',
  'cart_abandoned_step2',
  'cart_abandoned_step3',
  'back_in_stock',
];

// ─── renderSmsTemplate ────────────────────────────────────────────────────────

describe('renderSmsTemplate', () => {
  it('replaces {name} placeholder', () => {
    const result = renderSmsTemplate('Hello {name}!', sampleData);
    expect(result).toBe('Hello Ahmad!');
  });

  it('replaces {number} placeholder', () => {
    const result = renderSmsTemplate('Order #{number}', sampleData);
    expect(result).toBe('Order #ORD-001');
  });

  it('replaces {total} placeholder with 2 decimal places', () => {
    const result = renderSmsTemplate('Total: {total}', sampleData);
    expect(result).toBe('Total: 25.50');
  });

  it('replaces {amount} placeholder with 2 decimal places', () => {
    const result = renderSmsTemplate('Amount: {amount}', sampleData);
    expect(result).toBe('Amount: 25.50');
  });

  it('replaces {tracking} placeholder', () => {
    const result = renderSmsTemplate('Track: {tracking}', sampleData);
    expect(result).toBe('Track: TRK-999');
  });

  it('replaces {reason} placeholder', () => {
    const result = renderSmsTemplate('Reason: {reason}', sampleData);
    expect(result).toBe('Reason: Out of stock');
  });

  it('correctly renders a full order_confirmed SMS template', () => {
    const template = SMS_TEMPLATES.order_confirmed.en;
    const result = renderSmsTemplate(template, sampleData);
    expect(result).toContain('Ahmad');
    expect(result).toContain('ORD-001');
    expect(result).toContain('25.50');
  });

  it('handles missing optional fields gracefully', () => {
    const minimalData: NotificationData = {
      customerName: 'Ali',
      orderNumber: 'ORD-002',
      storeId: 'store-1',
      storeName: 'Ebda',
    };
    const result = renderSmsTemplate(
      'Track: {tracking} Reason: {reason} Total: {total}',
      minimalData
    );
    expect(result).toBe('Track:  Reason:  Total: ');
  });
});

// ─── SMS_TEMPLATES ────────────────────────────────────────────────────────────

describe('SMS_TEMPLATES', () => {
  it('has entries for all events', () => {
    for (const event of ALL_EVENTS) {
      expect(SMS_TEMPLATES).toHaveProperty(event);
    }
  });

  it('each entry has en and ar strings', () => {
    for (const event of ALL_EVENTS) {
      const template = SMS_TEMPLATES[event];
      expect(typeof template.en).toBe('string');
      expect(template.en.length).toBeGreaterThan(0);
      expect(typeof template.ar).toBe('string');
      expect(template.ar.length).toBeGreaterThan(0);
    }
  });
});

// ─── PUSH_TEMPLATES ───────────────────────────────────────────────────────────

describe('PUSH_TEMPLATES', () => {
  it('has entries for all events', () => {
    for (const event of ALL_EVENTS) {
      expect(PUSH_TEMPLATES).toHaveProperty(event);
    }
  });

  it('each entry has title and body with en and ar strings', () => {
    for (const event of ALL_EVENTS) {
      const template = PUSH_TEMPLATES[event];
      expect(typeof template.title.en).toBe('string');
      expect(template.title.en.length).toBeGreaterThan(0);
      expect(typeof template.title.ar).toBe('string');
      expect(template.title.ar.length).toBeGreaterThan(0);
      expect(typeof template.body.en).toBe('string');
      expect(template.body.en.length).toBeGreaterThan(0);
      expect(typeof template.body.ar).toBe('string');
      expect(template.body.ar.length).toBeGreaterThan(0);
    }
  });
});
