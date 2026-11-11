'use client';

import { Button } from '@/components/ui/Button';
import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import type { ChannelConfig, TestStatus } from './types';

interface SmsChannelCardProps {
  config: ChannelConfig;
  saving: boolean;
  testing: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<ChannelConfig>) => void;
  onSave: () => void;
  onTest: () => void;
}

/**
 * SMS (Unifonic) configuration card. Fields: appSid, senderId.
 */
export function SmsChannelCard({
  config,
  saving,
  testing,
  testStatus,
  onConfigChange,
  onSave,
  onTest,
}: SmsChannelCardProps) {
  const t = useT('notifications.sms');
  const tShared = useT('notifications.shared');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-info/10 rounded-xl flex items-center justify-center">
            <svg
              className="w-5 h-5 text-info"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {config.enabled ? tShared('enabled') : tShared('disabled')}
          </span>
          <Toggle checked={config.enabled} onChange={val => onConfigChange({ enabled: val })} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.appSid')}
          </label>
          {/* appSid is a Unifonic credential — mask it like a password. The
              server returns it masked (`****1234`) and treats a resubmitted
              masked value as "unchanged" (see notification-config.service). */}
          <input
            type="password"
            autoComplete="off"
            value={config.appSid || ''}
            onChange={e => onConfigChange({ appSid: e.target.value })}
            placeholder={t('placeholders.appSid')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.senderId')}
          </label>
          <input
            type="text"
            value={config.senderId || ''}
            onChange={e => onConfigChange({ senderId: e.target.value })}
            placeholder={t('placeholders.senderId')}
            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving} size="sm">
          {saving && (
            <span className="animate-spin inline-block h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
          )}
          {tShared('save')}
        </Button>
        <Button variant="outline" size="sm" onClick={onTest} disabled={testing}>
          {tShared('testConnection')}
        </Button>
        <ConnectionStatus status={testStatus} />
      </div>
    </div>
  );
}
