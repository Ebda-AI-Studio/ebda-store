'use client';

import { useT } from '@/i18n/useT';
import { minorToMajor } from '@/lib/format';
import type { AbandonedCartConfig } from './types';

import { roundToMinor } from '@ebda/shared';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/Toggle';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface StepRowProps {
  title: string;
  sendAfterLabel: string;
  minutesLabel: string;
  enabled: boolean;
  delay: number;
  onEnabledChange: (val: boolean) => void;
  onDelayChange: (val: number) => void;
  children?: React.ReactNode;
}

function StepRow({
  title,
  sendAfterLabel,
  minutesLabel,
  enabled,
  delay,
  onEnabledChange,
  onDelayChange,
  children,
}: StepRowProps) {
  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-foreground">{title}</h3>
        <Toggle checked={enabled} onChange={onEnabledChange} label={title} />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-muted-foreground">{sendAfterLabel}</label>
        <input
          type="number"
          min={1}
          value={delay}
          onChange={e => onDelayChange(Number(e.target.value))}
          disabled={!enabled}
          className={`${FIELD_CLASSES} w-20`}
        />
        <label className="text-sm text-muted-foreground">{minutesLabel}</label>
      </div>
      {children}
    </div>
  );
}

interface RecoveryCampaignFormProps {
  config: AbandonedCartConfig;
  saving: boolean;
  onPatch: (patch: Partial<AbandonedCartConfig>) => void;
  onSave: () => void;
}

/**
 * Recovery campaign configuration: three reminder steps (with enable toggle
 * and delay input) plus the optional auto-coupon block attached to step 3.
 * All labels come from the `abandonedCarts.campaign.*` namespace.
 */
export function RecoveryCampaignForm({
  config,
  saving,
  onPatch,
  onSave,
}: RecoveryCampaignFormProps) {
  const t = useT('abandonedCarts.campaign');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <h2 className="text-lg font-semibold text-foreground mb-5">{t('title')}</h2>

      <div className="space-y-6">
        <StepRow
          title={t('step1.title')}
          sendAfterLabel={t('sendAfter')}
          minutesLabel={t('minutes')}
          enabled={config.step1Enabled}
          delay={config.step1DelayMinutes}
          onEnabledChange={val => onPatch({ step1Enabled: val })}
          onDelayChange={val => onPatch({ step1DelayMinutes: val })}
        />

        <StepRow
          title={t('step2.title')}
          sendAfterLabel={t('sendAfter')}
          minutesLabel={t('minutes')}
          enabled={config.step2Enabled}
          delay={config.step2DelayMinutes}
          onEnabledChange={val => onPatch({ step2Enabled: val })}
          onDelayChange={val => onPatch({ step2DelayMinutes: val })}
        />

        <StepRow
          title={t('step3.title')}
          sendAfterLabel={t('sendAfter')}
          minutesLabel={t('minutes')}
          enabled={config.step3Enabled}
          delay={config.step3DelayMinutes}
          onEnabledChange={val => onPatch({ step3Enabled: val })}
          onDelayChange={val => onPatch({ step3DelayMinutes: val })}
        >
          <div className="pt-4 mt-4 border-t border-border space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{t('autoCoupon.title')}</span>
              <Toggle
                checked={config.autoCouponEnabled}
                onChange={val => onPatch({ autoCouponEnabled: val })}
                label={t('autoCoupon.title')}
                disabled={!config.step3Enabled}
              />
            </div>
            {config.autoCouponEnabled && config.step3Enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    {t('autoCoupon.discount')}
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={config.couponDiscountPercent}
                      onChange={e => onPatch({ couponDiscountPercent: Number(e.target.value) })}
                      className={FIELD_CLASSES}
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    {t('autoCoupon.maxDiscount')}
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      step={0.01}
                      value={
                        config.couponMaxDiscount !== null && config.couponMaxDiscount !== undefined
                          ? minorToMajor(config.couponMaxDiscount)
                          : ''
                      }
                      onChange={e =>
                        onPatch({
                          couponMaxDiscount: e.target.value
                            ? roundToMinor(parseFloat(e.target.value))
                            : null,
                        })
                      }
                      placeholder={t('autoCoupon.noLimit')}
                      className={FIELD_CLASSES}
                    />
                    <span className="text-sm text-muted-foreground">{t('autoCoupon.major')}</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    {t('autoCoupon.expiry')}
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={1}
                      value={config.couponExpiryHours}
                      onChange={e => onPatch({ couponExpiryHours: Number(e.target.value) })}
                      className={FIELD_CLASSES}
                    />
                    <span className="text-sm text-muted-foreground">{t('autoCoupon.hours')}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </StepRow>

        <div id="cart-email-settings" className="border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-medium text-foreground">{t('email.title')}</h3>
            <Toggle
              checked={config.emailEnabled}
              onChange={val => onPatch({ emailEnabled: val })}
              label={t('email.title')}
            />
          </div>
          <p className="text-sm text-muted-foreground mb-3">{t('email.description')}</p>
          <div className="flex items-center gap-2">
            <label htmlFor="cart-email-delay" className="text-sm text-muted-foreground">
              {t('email.sendAfter')}
            </label>
            <input
              id="cart-email-delay"
              type="number"
              min={60}
              max={1440}
              value={config.emailDelayMinutes}
              onChange={e => onPatch({ emailDelayMinutes: Number(e.target.value) })}
              disabled={!config.emailEnabled}
              className={`${FIELD_CLASSES} w-20`}
            />
            <span className="text-sm text-muted-foreground">{t('email.minutes')}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">{t('email.hint')}</p>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <Button variant="default" size="md" type="button" onClick={onSave} disabled={saving}>
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
          )}
          {t('save')}
        </Button>
      </div>
    </div>
  );
}
