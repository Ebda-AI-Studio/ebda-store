'use client';

/**
 * ServiceMenuCard — 4 toggles that control which service-menu items appear
 * when the customer first DMs the bot, plus optional EN/AR label overrides.
 *
 * Saves via PUT /api/v1/stores/:id/integrations/wbs { botServiceMenu }.
 */

import { useState } from 'react';
import { Button, useToast } from '@force/ui';
import { apiPut } from '../../../../lib/api';
import { Toggle } from '../../../../components/Toggle';
import type { BotServiceMenu } from '../../../../lib/types/wa-bot';
import { DEFAULT_SERVICE_MENU } from '../../../../lib/types/wa-bot';

interface ServiceMenuItem {
  key: keyof Omit<BotServiceMenu, 'labels'>;
  label: string;
  description: string;
  labelKey: string; // key in labels.en / labels.ar
}

const MENU_ITEMS: ServiceMenuItem[] = [
  {
    key: 'orderNow',
    label: 'Order Now',
    description: 'Opens the product catalog / ordering flow.',
    labelKey: 'order_now',
  },
  {
    key: 'subscriptionBoxes',
    label: 'Subscription Boxes',
    description: 'Routes customer to subscription info.',
    labelKey: 'subscription_boxes',
  },
  {
    key: 'locationsHours',
    label: 'Locations & Hours',
    description: 'Sends store address, Google Maps link, and business hours.',
    labelKey: 'locations_hours',
  },
  {
    key: 'chatWithAgent',
    label: 'Chat with Agent',
    description: 'Hands conversation off to a human team member.',
    labelKey: 'chat_with_agent',
  },
];

interface ServiceMenuCardProps {
  storeId: string;
  initialMenu: BotServiceMenu;
}

export function ServiceMenuCard({ storeId, initialMenu }: ServiceMenuCardProps) {
  const { success: toastSuccess, error: toastError } = useToast();

  const [menu, setMenu] = useState<BotServiceMenu>({
    ...DEFAULT_SERVICE_MENU,
    ...initialMenu,
    labels: {
      en: initialMenu.labels?.en ?? {},
      ar: initialMenu.labels?.ar ?? {},
    },
  });
  const [saving, setSaving] = useState(false);
  const [showLabels, setShowLabels] = useState(false);

  const toggle = (key: keyof Omit<BotServiceMenu, 'labels'>) => {
    setMenu((prev: BotServiceMenu) => ({ ...prev, [key]: !prev[key] }));
  };

  const setLabel = (locale: 'en' | 'ar', labelKey: string, value: string) => {
    setMenu((prev: BotServiceMenu) => ({
      ...prev,
      labels: {
        ...prev.labels,
        [locale]: {
          ...(prev.labels?.[locale] ?? {}),
          [labelKey]: value,
        },
      },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
      botServiceMenu: menu,
    });
    setSaving(false);
    if (error) {
      toastError(error.message || 'Failed to save service menu');
    } else {
      toastSuccess('Service menu saved');
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">Service Menu</h2>
      <p className="text-sm text-muted-foreground mb-5">
        Choose which options appear when a customer first messages the bot.
      </p>

      <div className="space-y-4">
        {MENU_ITEMS.map(item => (
          <div key={String(item.key)} className="flex items-start gap-3">
            <Toggle checked={menu[item.key] as boolean} onChange={() => toggle(item.key)} />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">{item.label}</p>
              <p className="text-xs text-muted-foreground">{item.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Label customization (collapsed by default) */}
      <button
        type="button"
        onClick={() => setShowLabels(v => !v)}
        className="mt-5 text-xs text-primary hover:underline focus:outline-none"
      >
        {showLabels ? '▲ Hide label customisation' : '▼ Customise button labels (optional)'}
      </button>

      {showLabels && (
        <div className="mt-4 space-y-5 rounded-lg border border-border bg-muted/30 p-4">
          {MENU_ITEMS.map(item => (
            <div key={item.labelKey}>
              <p className="text-xs font-medium text-foreground mb-2">{item.label}</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">English label</label>
                  <input
                    type="text"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder={item.label}
                    value={menu.labels?.en?.[item.labelKey] ?? ''}
                    onChange={e => setLabel('en', item.labelKey, e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Arabic label</label>
                  <input
                    type="text"
                    dir="rtl"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    placeholder=""
                    value={menu.labels?.ar?.[item.labelKey] ?? ''}
                    onChange={e => setLabel('ar', item.labelKey, e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
