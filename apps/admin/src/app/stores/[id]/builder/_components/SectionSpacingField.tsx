'use client';

/**
 * Top / Bottom spacing of one section, per device (editor Ruling SP-1).
 *
 * "Same on all devices" (default) edits the base value, which every device uses. Off, the device
 * tabs appear and the editor's device switch picks which device is edited: Desktop writes
 * `settings.paddingTop|Bottom`, Tablet / Mobile write `responsive.<vp>.settings.paddingTop|Bottom`.
 * A device with no value of its own shows the value it inherits (device, then base, then the
 * baseline), so the readout is always the real height.
 */
import { useState } from 'react';
import {
  SECTION_SPACING_PRESETS,
  VIEWPORTS,
  hasDeviceSpacing,
  resolveSpacingPx,
  resolveSpacingPreset,
  spacingLegacyKey,
  type DocumentAction,
  type SectionNode,
  type SectionSpacingPreset,
  type SpacingAxis,
  type Viewport,
} from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Toggle } from '../../../../../components/Toggle';

type Values = Record<string, unknown>;

/** The legacy-shaped view of a node's spacing: `paddingTop`, `paddingTopTablet`, ... */
export function spacingValues(node: SectionNode): Values {
  const out: Values = {};
  for (const axis of ['Top', 'Bottom'] as const) {
    for (const v of VIEWPORTS) {
      const raw =
        v === 'desktop'
          ? node.settings[`padding${axis}`]
          : node.responsive?.[v]?.settings?.[`padding${axis}`];
      if (raw !== undefined) out[spacingLegacyKey(axis, v)] = raw;
    }
  }
  return out;
}

const AXES: readonly SpacingAxis[] = ['Top', 'Bottom'];

export function SectionSpacingField({
  node,
  viewport,
  onViewportChange,
  dispatch,
}: {
  node: SectionNode;
  viewport: Viewport;
  onViewportChange?: (v: Viewport) => void;
  dispatch: (a: DocumentAction, coalesceKey?: string) => void;
}) {
  const t = useT('builder.settings');
  const values = spacingValues(node);
  const [forcedSplit, setForcedSplit] = useState(false);
  const split = forcedSplit || hasDeviceSpacing(values);
  /** The device being edited: the base (desktop key) while the same-everywhere switch is on. */
  const editing: Viewport = split ? viewport : 'desktop';

  const write = (axis: SpacingAxis, v: Viewport, value: SectionSpacingPreset | undefined) => {
    const key = `padding${axis}`;
    const coalesce = `${node.id}//${spacingLegacyKey(axis, v)}`;
    if (v === 'desktop') dispatch({ type: 'setSectionSetting', id: node.id, key, value }, coalesce);
    else dispatch({ type: 'setViewportSetting', id: node.id, viewport: v, key, value }, coalesce);
  };

  const ownValue = (axis: SpacingAxis, v: Viewport) => values[spacingLegacyKey(axis, v)];
  const differs = (v: Viewport) => AXES.some(a => ownValue(a, v) !== undefined);

  const setSame = (on: boolean) => {
    if (!on) {
      setForcedSplit(true);
      return;
    }
    // back to one value: drop every tablet / mobile override
    for (const v of ['tablet', 'mobile'] as const) for (const a of AXES) write(a, v, undefined);
    setForcedSplit(false);
  };

  return (
    <fieldset
      className="space-y-3"
      data-testid="section-spacing-field"
      data-field-id="paddingTop"
      data-setting-id="builder.section-spacing"
    >
      <legend className="text-xs font-semibold text-muted-foreground">{t('spacing.title')}</legend>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>{t('spacing.sameOnAll')}</span>
        <Toggle checked={!split} onChange={setSame} />
      </label>
      {split && (
        <div
          role="tablist"
          aria-label={t('spacing.devices')}
          className="inline-flex rounded-lg bg-muted p-0.5 text-xs"
        >
          {VIEWPORTS.map(v => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={editing === v}
              data-testid={`spacing-device-${v}`}
              onClick={() => onViewportChange?.(v)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 max-lg:min-h-11 ${
                editing === v ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'
              }`}
            >
              {t(`viewport.${v}`)}
              {differs(v) && (
                <span
                  aria-label={t('spacing.differs')}
                  className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
                />
              )}
            </button>
          ))}
        </div>
      )}
      {AXES.map(axis => {
        const current = resolveSpacingPreset(values, axis, editing);
        const own = ownValue(axis, editing);
        const px = resolveSpacingPx(values, axis, editing);
        const label = t(axis === 'Top' ? 'spacing.top' : 'spacing.bottom');
        return (
          <div key={axis} data-spacing-axis={axis}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">{label}</span>
              <span className="text-xs tabular-nums text-muted-foreground" dir="ltr">
                {t('spacing.px', { px })}
              </span>
            </div>
            <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-1">
              {SECTION_SPACING_PRESETS.map(p => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={current === p}
                  data-testid={`spacing-${axis.toLowerCase()}-${p}`}
                  onClick={() => write(axis, editing, p)}
                  className={`rounded-md border px-1 py-1.5 text-xs max-lg:min-h-11 ${
                    current === p
                      ? 'border-primary bg-primary/10 font-semibold text-primary-ink'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {t(`spacing.preset.${p}`)}
                </button>
              ))}
            </div>
            {own !== undefined && (
              <button
                type="button"
                onClick={() => write(axis, editing, undefined)}
                className="mt-1 text-xs text-primary hover:underline"
              >
                {t(editing === 'desktop' ? 'spacing.resetDefault' : 'spacing.resetInherit')}
              </button>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{t('spacing.hint')}</p>
    </fieldset>
  );
}
