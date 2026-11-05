'use client';

import { useT } from '@/i18n/useT';

export interface PickupAddress {
  name: string;
  phone: string;
  line1: string;
  city: string;
  area: string;
}

export const DEFAULT_PICKUP: PickupAddress = {
  name: '',
  phone: '',
  line1: '',
  city: 'Cairo',
  area: '',
};

const FIELDS: Array<keyof PickupAddress> = ['name', 'phone', 'line1', 'city', 'area'];

/**
 * The pickup address every carrier collects from (Egypt: a contact, a street line, the
 * governorate and the district). The parent owns the state and passes a patch-style onChange so
 * partial updates don't rewrite the whole object.
 */
export function PickupAddressForm({
  value,
  onChange,
}: {
  value: PickupAddress;
  onChange: (patch: Partial<PickupAddress>) => void;
}) {
  const t = useT('shipping.carriers.pickup');

  return (
    <div className="border border-border rounded-lg p-4 mt-4">
      <h4 className="text-sm font-medium text-foreground mb-3">{t('title')}</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {FIELDS.map(field => (
          <div key={field}>
            <label className="block text-xs text-muted-foreground mb-1">
              {t(`fields.${field}`)}
            </label>
            <input
              type={field === 'phone' ? 'tel' : 'text'}
              value={value[field]}
              onChange={e => onChange({ [field]: e.target.value })}
              placeholder={t(`placeholders.${field}`)}
              className="w-full px-3 py-2 border border-input rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
