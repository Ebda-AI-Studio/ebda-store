'use client';

import { useT } from '@/i18n/useT';
import { hexToHsl, hexToRgb, hslToHex, rgbToHex } from '../../../../../lib/color';
import { COLOR_PRESETS } from './types';

interface ColorPalettePickerProps {
  label: string;
  hslValue: string;
  onChange: (hslValue: string) => void;
  showPresets?: boolean;
  placeholder?: string;
}

/**
 * Editor for a single theme color stored as an HSL triplet.
 * Surfaces preset swatches, a native color picker, and synchronized
 * HEX / RGB inputs. All edits converge on HSL to match the DB format.
 */
export function ColorPalettePicker({
  label,
  hslValue,
  onChange,
  showPresets = false,
  placeholder,
}: ColorPalettePickerProps) {
  const t = useT('branding.theme');
  const tPresets = useT('branding.theme.presets');

  const currentHex = hslValue ? hslToHex(hslValue) : '#000000';
  const currentHexUpper = currentHex.toUpperCase();
  const rgb = hexToRgb(currentHex);

  const setHex = (hex: string) => {
    onChange(hexToHsl(hex));
  };

  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-3">{label}</label>

      {showPresets && (
        <div className="flex flex-wrap gap-3 mb-3">
          {COLOR_PRESETS.map(preset => {
            const isSelected = currentHexUpper === preset.hex.toUpperCase();
            return (
              <button
                key={preset.key}
                onClick={() => setHex(preset.hex)}
                className={`w-10 h-10 rounded-full border-2 transition-all ${
                  isSelected ? 'border-foreground scale-110' : 'border-transparent hover:scale-105'
                }`}
                style={{ backgroundColor: preset.hex }}
                title={`${tPresets(preset.key)} (${preset.hex})`}
              />
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="color"
          value={currentHex}
          onChange={e => setHex(e.target.value)}
          className="w-10 h-10 rounded-lg border border-border cursor-pointer p-0.5"
        />
        <div>
          <label className="block text-[10px] text-muted-foreground mb-0.5">{t('hex')}</label>
          <input
            type="text"
            value={currentHexUpper}
            onChange={e => {
              const v = e.target.value;
              if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                setHex(v);
              }
            }}
            placeholder={placeholder}
            maxLength={7}
            className="w-24 px-3 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono text-sm"
          />
        </div>
        {(['r', 'g', 'b'] as const).map(channel => (
          <div key={channel}>
            <label className="block text-[10px] text-muted-foreground mb-0.5">
              {channel.toUpperCase()}
            </label>
            <input
              type="number"
              min={0}
              max={255}
              value={rgb[channel]}
              onChange={e => {
                const val = parseInt(e.target.value, 10) || 0;
                const newRgb = { ...rgb, [channel]: val };
                setHex(rgbToHex(newRgb.r, newRgb.g, newRgb.b));
              }}
              className="w-16 px-2 py-1.5 border border-border rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm text-center"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
