'use client';

import { Button } from '@force/ui';
import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import type { ChannelConfig, TestStatus } from './types';

interface WhatsAppChannelCardProps {
  config: ChannelConfig;
  saving: boolean;
  testing: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<ChannelConfig>) => void;
  onSave: () => void;
  onTest: () => void;
}

/**
 * WhatsApp Business API configuration card. Fields: phoneNumberId, wabaId,
 * accessToken. Access token is masked via type=password.
 */
export function WhatsAppChannelCard({
  config,
  saving,
  testing,
  testStatus,
  onConfigChange,
  onSave,
  onTest,
}: WhatsAppChannelCardProps) {
  const t = useT('notifications.whatsapp');
  const tShared = useT('notifications.shared');

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-success/10 rounded-xl flex items-center justify-center">
            <svg className="w-5 h-5 text-success" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
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
            {t('fields.phoneNumberId')}
          </label>
          <input
            type="text"
            value={config.phoneNumberId || ''}
            onChange={e => onConfigChange({ phoneNumberId: e.target.value })}
            placeholder={t('placeholders.phoneNumberId')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.wabaId')}
          </label>
          <input
            type="text"
            value={config.wabaId || ''}
            onChange={e => onConfigChange({ wabaId: e.target.value })}
            placeholder={t('placeholders.wabaId')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            {t('fields.accessToken')}
          </label>
          <input
            type="password"
            value={config.accessToken || ''}
            onChange={e => onConfigChange({ accessToken: e.target.value })}
            placeholder={t('placeholders.accessToken')}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
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
