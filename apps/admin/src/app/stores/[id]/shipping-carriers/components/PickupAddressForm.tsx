export interface PickupAddress {
  area: string;
  block: string;
  street: string;
  building: string;
}

export const DEFAULT_PICKUP: PickupAddress = {
  area: '',
  block: '',
  street: '',
  building: '',
};

/**
 * 4-field form (Area / Block / Street / Building) used by both carriers'
 * settings cards on the shipping-carriers page. The parent owns the state
 * and passes a patch-style onChange so partial updates don't rewrite the
 * whole object.
 */
export function PickupAddressForm({
  value,
  onChange,
}: {
  value: PickupAddress;
  onChange: (patch: Partial<PickupAddress>) => void;
}) {
  return (
    <div className="border border-border rounded-lg p-4 mt-4">
      <h4 className="text-sm font-medium text-foreground mb-3">Pickup Address</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Area</label>
          <input
            type="text"
            value={value.area}
            onChange={e => onChange({ area: e.target.value })}
            placeholder="e.g. Salmiya"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Block</label>
          <input
            type="text"
            value={value.block}
            onChange={e => onChange({ block: e.target.value })}
            placeholder="e.g. 12"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Street</label>
          <input
            type="text"
            value={value.street}
            onChange={e => onChange({ street: e.target.value })}
            placeholder="e.g. Gulf Road"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Building</label>
          <input
            type="text"
            value={value.building}
            onChange={e => onChange({ building: e.target.value })}
            placeholder="e.g. Al Hamra"
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>
    </div>
  );
}
