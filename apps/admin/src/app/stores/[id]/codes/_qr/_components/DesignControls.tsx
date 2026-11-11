'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/useT';
import {
  HEX_COLOR,
  QR_CTA_MAX,
  contrastRatio,
  validateColours,
  type QrDesign,
} from '@ebda/shared/qr';
import { Segmented } from './Segmented';
import { FIELD_CLASSES, TEXTAREA_CLASSES } from '@/components/ui/tokens';

const CODE_SWATCHES = ['#14110d', '#1f3a2e', '#1d3557', '#5b1a2b', '#3a2a1a'];
const BG_SWATCHES = ['#ffffff', '#faf6ee', '#f2efe8'];
const FRAME_SWATCHES = ['#b08d57', '#14110d', '#1f3a2e', '#1d3557', '#5b1a2b'];

type Props = {
  design: QrDesign;
  onChange: (d: QrDesign) => void;
  hasLogo: boolean;
  logoFailed: boolean;
  whatsappText: string;
  onWhatsappText: (v: string) => void;
  showWhatsappText: boolean;
};

function ColorRow({
  label,
  value,
  swatches,
  onChange,
}: {
  label: string;
  value: string;
  swatches: string[];
  onChange: (hex: string) => void;
}) {
  const t = useT('qr.colors');
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = `qr-color-${label.replace(/\s+/g, '-')}`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor={id} className="w-28 shrink-0 text-sm text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-1.5" role="group" aria-label={label}>
        {swatches.map(c => (
          <button
            data-ui="swatch"
            key={c}
            type="button"
            aria-label={t('swatch', { color: c })}
            aria-pressed={c.toLowerCase() === value.toLowerCase()}
            onClick={() => onChange(c)}
            style={{ backgroundColor: c }}
            className="h-7 w-7 rounded-full border border-border ring-offset-2 ring-offset-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 aria-pressed:ring-2 aria-pressed:ring-foreground"
          />
        ))}
      </div>
      <input
        id={id}
        dir="ltr"
        value={text}
        maxLength={7}
        spellCheck={false}
        aria-label={t('hex')}
        onChange={e => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setText(v);
          if (HEX_COLOR.test(v)) onChange(v.toLowerCase());
        }}
        className={`${FIELD_CLASSES} w-24 font-mono`}
      />
    </div>
  );
}

export function DesignControls({
  design,
  onChange,
  hasLogo,
  logoFailed,
  whatsappText,
  onWhatsappText,
  showWhatsappText,
}: Props) {
  const tl = useT('qr.look');
  const tc = useT('qr.colors');
  const tg = useT('qr.logo');
  const tt = useT('qr.cta');
  const tw = useT('qr.whatsapp');
  const set = (patch: Partial<QrDesign>) => onChange({ ...design, ...patch });
  const problems = validateColours(design.fg, design.bg);
  const ratio = contrastRatio(design.fg, design.bg).toFixed(1);
  const framed = design.frame !== 'none';
  const cta = design.cta ?? { text: '', lang: 'ar' as const };

  return (
    <div className="space-y-6">
      <section className="space-y-3" aria-labelledby="qr-looks">
        <h2 id="qr-looks" className="text-base font-semibold text-foreground">
          {tl('title')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-[7rem_1fr] sm:items-center">
          <span className="text-sm text-muted-foreground">{tl('style')}</span>
          <Segmented
            label={tl('style')}
            value={design.style}
            onChange={style => set({ style })}
            options={(['square', 'rounded', 'dots'] as const).map(v => ({
              value: v,
              label: tl(`styles.${v}`),
            }))}
          />
          <span className="text-sm text-muted-foreground">{tl('finder')}</span>
          <Segmented
            label={tl('finder')}
            value={design.finder}
            onChange={finder => set({ finder })}
            options={(['square', 'rounded', 'circle'] as const).map(v => ({
              value: v,
              label: tl(`finders.${v}`),
            }))}
          />
          <span className="text-sm text-muted-foreground">{tl('frame')}</span>
          <Segmented
            label={tl('frame')}
            value={design.frame}
            onChange={frame => set({ frame, cta: frame === 'none' ? null : design.cta })}
            options={(['none', 'card', 'badge'] as const).map(v => ({
              value: v,
              label: tl(`frames.${v}`),
            }))}
          />
        </div>
      </section>

      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="qr-colors">
        <h2 id="qr-colors" className="text-base font-semibold text-foreground">
          {tc('title')}
        </h2>
        <ColorRow
          label={tc('fg')}
          value={design.fg}
          swatches={CODE_SWATCHES}
          onChange={fg => set({ fg })}
        />
        <ColorRow
          label={tc('bg')}
          value={design.bg}
          swatches={BG_SWATCHES}
          onChange={bg => set({ bg })}
        />
        {framed && (
          <ColorRow
            label={tc('frameColor')}
            value={design.frameColor}
            swatches={FRAME_SWATCHES}
            onChange={frameColor => set({ frameColor })}
          />
        )}
        <p
          className={
            problems.length ? 'text-sm text-destructive-ink' : 'text-xs text-muted-foreground'
          }
          role={problems.length ? 'alert' : undefined}
        >
          {problems.includes('inverted')
            ? tc('inverted')
            : problems.includes('low-contrast')
              ? tc('lowContrast', { ratio })
              : tc('ratio', { ratio })}
        </p>
      </section>

      <section className="space-y-2 border-t border-border pt-5" aria-labelledby="qr-logo">
        <h2 id="qr-logo" className="text-base font-semibold text-foreground">
          {tg('title')}
        </h2>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={design.logo}
            disabled={!hasLogo}
            onChange={e => set({ logo: e.target.checked })}
          />
          {tg('use')}
        </label>
        <p className="text-xs text-muted-foreground">
          {!hasLogo ? tg('noLogo') : logoFailed ? tg('loadFail') : tg('hint')}
        </p>
      </section>

      <section className="space-y-3 border-t border-border pt-5" aria-labelledby="qr-cta">
        <h2 id="qr-cta" className="text-base font-semibold text-foreground">
          {tt('title')}
        </h2>
        {!framed ? (
          <p className="text-sm text-muted-foreground">{tt('needFrame')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[7rem_1fr] sm:items-center">
            <label htmlFor="qr-cta-text" className="text-sm text-muted-foreground">
              {tt('text')}
            </label>
            <div>
              <input
                id="qr-cta-text"
                value={cta.text}
                maxLength={QR_CTA_MAX}
                dir={cta.lang === 'ar' ? 'rtl' : 'ltr'}
                placeholder={tt('placeholder')}
                onChange={e =>
                  set({ cta: e.target.value ? { ...cta, text: e.target.value } : null })
                }
                className={FIELD_CLASSES}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {tt('remaining', { count: QR_CTA_MAX - cta.text.length })}
              </p>
            </div>
            <span className="text-sm text-muted-foreground">{tt('lang')}</span>
            <Segmented
              label={tt('lang')}
              value={cta.lang}
              onChange={lang => set({ cta: { text: cta.text || tt('placeholder'), lang } })}
              options={[
                { value: 'ar', label: tt('ar') },
                { value: 'en', label: tt('en') },
              ]}
            />
          </div>
        )}
      </section>

      {showWhatsappText && (
        <section className="space-y-2 border-t border-border pt-5" aria-labelledby="qr-wa">
          <label
            id="qr-wa"
            htmlFor="qr-wa-text"
            className="block text-base font-semibold text-foreground"
          >
            {tw('textLabel')}
          </label>
          <textarea
            id="qr-wa-text"
            rows={2}
            maxLength={200}
            value={whatsappText}
            placeholder={tw('textPlaceholder')}
            onChange={e => onWhatsappText(e.target.value)}
            className={TEXTAREA_CLASSES}
          />
          <p className="text-xs text-muted-foreground">{tw('hint')}</p>
        </section>
      )}
    </div>
  );
}
