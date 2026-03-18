/**
 * Communication Hub — Notification Unit Tests
 * Tests for notification types, templates, and Zod schemas
 */

import { describe, it, expect } from 'vitest';

// Import directly from source (same pattern as feature.test.ts)
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_CHANNELS,
  WHATSAPP_TEMPLATES,
  SMS_TEMPLATES,
  PUSH_TEMPLATES,
  renderSmsTemplate,
  notificationChannelSchema,
  notificationEventSchema,
  type NotificationData,
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
  storeName: 'Force Store',
};

// ─── NOTIFICATION_EVENTS ──────────────────────────────────────────────────────

describe('NOTIFICATION_EVENTS', () => {
  it('has exactly 6 entries', () => {
    expect(NOTIFICATION_EVENTS).toHaveLength(6);
  });

  it('contains the expected event names', () => {
    expect(NOTIFICATION_EVENTS).toContain('order_confirmed');
    expect(NOTIFICATION_EVENTS).toContain('payment_success');
    expect(NOTIFICATION_EVENTS).toContain('order_shipped');
    expect(NOTIFICATION_EVENTS).toContain('order_delivered');
    expect(NOTIFICATION_EVENTS).toContain('order_cancelled');
    expect(NOTIFICATION_EVENTS).toContain('refund_processed');
  });
});

// ─── NOTIFICATION_CHANNELS ────────────────────────────────────────────────────

describe('NOTIFICATION_CHANNELS', () => {
  it('has exactly 3 entries', () => {
    expect(NOTIFICATION_CHANNELS).toHaveLength(3);
  });

  it('contains whatsapp, sms, and push', () => {
    expect(NOTIFICATION_CHANNELS).toContain('whatsapp');
    expect(NOTIFICATION_CHANNELS).toContain('sms');
    expect(NOTIFICATION_CHANNELS).toContain('push');
  });
});

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
      storeName: 'Force Store',
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
  it('has entries for all 6 events', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(SMS_TEMPLATES).toHaveProperty(event);
    }
  });

  it('each entry has en and ar strings', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const template = SMS_TEMPLATES[event];
      expect(typeof template.en).toBe('string');
      expect(template.en.length).toBeGreaterThan(0);
      expect(typeof template.ar).toBe('string');
      expect(template.ar.length).toBeGreaterThan(0);
    }
  });
});

// ─── WHATSAPP_TEMPLATES ───────────────────────────────────────────────────────

describe('WHATSAPP_TEMPLATES', () => {
  it('has entries for all 6 events', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(WHATSAPP_TEMPLATES).toHaveProperty(event);
    }
  });

  it('each entry has a name string and variables function', () => {
    for (const event of NOTIFICATION_EVENTS) {
      const template = WHATSAPP_TEMPLATES[event];
      expect(typeof template.name).toBe('string');
      expect(template.name.length).toBeGreaterThan(0);
      expect(typeof template.variables).toBe('function');
    }
  });

  it('variables function returns an array of strings', () => {
    const vars = WHATSAPP_TEMPLATES.order_confirmed.variables(sampleData);
    expect(Array.isArray(vars)).toBe(true);
    expect(vars.every(v => typeof v === 'string')).toBe(true);
    expect(vars).toContain('Ahmad');
    expect(vars).toContain('ORD-001');
  });
});

// ─── PUSH_TEMPLATES ───────────────────────────────────────────────────────────

describe('PUSH_TEMPLATES', () => {
  it('has entries for all 6 events', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(PUSH_TEMPLATES).toHaveProperty(event);
    }
  });

  it('each entry has title and body with en and ar strings', () => {
    for (const event of NOTIFICATION_EVENTS) {
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

// ─── notificationChannelSchema ────────────────────────────────────────────────

describe('notificationChannelSchema', () => {
  it('validates valid channel: whatsapp', () => {
    expect(notificationChannelSchema.safeParse('whatsapp').success).toBe(true);
  });

  it('validates valid channel: sms', () => {
    expect(notificationChannelSchema.safeParse('sms').success).toBe(true);
  });

  it('validates valid channel: push', () => {
    expect(notificationChannelSchema.safeParse('push').success).toBe(true);
  });

  it('rejects invalid channel: email', () => {
    expect(notificationChannelSchema.safeParse('email').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(notificationChannelSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(notificationChannelSchema.safeParse(42).success).toBe(false);
  });
});

// ─── notificationEventSchema ──────────────────────────────────────────────────

describe('notificationEventSchema', () => {
  it('validates valid event: order_confirmed', () => {
    expect(notificationEventSchema.safeParse('order_confirmed').success).toBe(true);
  });

  it('validates valid event: refund_processed', () => {
    expect(notificationEventSchema.safeParse('refund_processed').success).toBe(true);
  });

  it('rejects invalid event: order_pending', () => {
    expect(notificationEventSchema.safeParse('order_pending').success).toBe(false);
  });

  it('rejects empty string', () => {
    expect(notificationEventSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(notificationEventSchema.safeParse(null).success).toBe(false);
  });
});
