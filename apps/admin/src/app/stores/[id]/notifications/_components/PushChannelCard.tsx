'use client';

import { Button } from '@/components/ui/Button';
import { Toggle } from '../../../../../components/Toggle';
import { ConnectionStatus } from '../../../../../components/ConnectionStatus';
import { useT } from '@/i18n/useT';
import type { ChannelConfig, TestStatus } from './types';
import { usePushStatus } from './usePushStatus';

interface PushChannelCardProps {
  storeId: string;
  config: ChannelConfig;
  saving: boolean;
  testing: boolean;
  testStatus: TestStatus;
  onConfigChange: (patch: Partial<ChannelConfig>) => void;
  onSave: () => void;
  onTest: () => void;
}

/**
 * Browser push card. No per-store credentials: the platform keys are ours. Says in plain words whether push is
 * available yet. Shows subscriber count if reported by the API.
 */
export function PushChannelCard({
  storeId,
  config,
  saving,
  testing,
  testStatus,
  onConfigChange,
  onSave,
  onTest,
}: PushChannelCardProps) {
  const t = useT('notifications.push');
  const tShared = useT('notifications.shared');
  const pushStatus = usePushStatus(storeId);

  return (
    <div className="bg-card rounded-md border border-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-info/10 rounded-md flex items-center justify-center">
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
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {typeof config.subscriberCount === 'number' && (
            <span className="text-sm text-muted-foreground">
              {t('subscribers', { count: config.subscriberCount })}
            </span>
          )}
          <span className="text-sm text-muted-foreground">
            {config.enabled ? tShared('enabled') : tShared('disabled')}
          </span>
          <Toggle
            checked={config.enabled}
            onChange={val => onConfigChange({ enabled: val })}
            label={t('title')}
          />
        </div>
      </div>

      <div className="mb-4 p-4 bg-muted/50 border border-border rounded-lg">
        <p className="text-sm text-muted-foreground">{t('platformNote')}</p>
        {pushStatus.available !== null && (
          <p className="mt-2 text-sm font-medium text-foreground" data-testid="push-availability">
            {pushStatus.available ? t('statusAvailable') : t('statusUnavailable')}
          </p>
        )}
        {pushStatus.available === false && (
          <p className="mt-1 text-sm text-muted-foreground">{t('unavailableHint')}</p>
        )}
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
