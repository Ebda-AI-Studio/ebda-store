'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { StoreTheme } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { AutoPopulateBanner } from './_components/AutoPopulateBanner';
import { PwaBenefits } from './_components/PwaBenefits';
import { PwaBranding } from './_components/PwaBranding';
import { PwaIconUploader } from './_components/PwaIconUploader';
import { PwaInstallBanner } from './_components/PwaInstallBanner';
import { PwaIosSettings } from './_components/PwaIosSettings';
import { PwaManifestPreview } from './_components/PwaManifestPreview';
import { PwaStatusMessage } from './_components/PwaStatusMessage';
import { usePwaSettings } from './_hooks/usePwaSettings';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function PWASettingsPage() {
  const { gate } = useRequireFeature('pwa');

  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('pwa.page');
  const tActions = useT('pwa.actions');
  const tMessages = useT('pwa.messages');

  const {
    storeInfo,
    loading,
    saving,
    pwaEnabled,
    settings,
    setSettings,
    message,
    populateFromStore,
    toggleEnabled,
    saveSettings,
  } = usePwaSettings(storeId);

  const handleToggleEnabled = () => {
    toggleEnabled(tMessages('toggleError'));
  };

  // Sticky Save shows only while the settings differ from what was loaded/saved.
  const [baseline, setBaseline] = useState<string | null>(null);
  const snapshot = JSON.stringify(settings);
  useEffect(() => {
    if (!loading && baseline === null) setBaseline(snapshot);
  }, [loading, baseline, snapshot]);
  const dirty = pwaEnabled && baseline !== null && snapshot !== baseline;

  const handleSaveSettings = async () => {
    if (await saveSettings(tMessages('saveSuccess'), tMessages('saveError'))) setBaseline(snapshot);
  };

  const handlePopulate = () => {
    populateFromStore(tMessages('populated'));
  };

  if (gate) return gate;

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="space-y-6 pb-24">
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">
                {tActions('switchTitle')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {pwaEnabled ? tActions('enabled') : tActions('disabled')}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={pwaEnabled}
              disabled={saving}
              onChange={handleToggleEnabled}
              className="h-5 w-9 cursor-pointer accent-primary"
            />
          </label>

          {storeInfo && <AutoPopulateBanner storeInfo={storeInfo} onPopulate={handlePopulate} />}

          <PwaBenefits />

          <PwaBranding settings={settings} pwaEnabled={pwaEnabled} onChange={setSettings} />

          <PwaIconUploader
            storeId={storeId}
            settings={settings}
            pwaEnabled={pwaEnabled}
            onChange={setSettings}
          />

          <PwaInstallBanner settings={settings} pwaEnabled={pwaEnabled} onChange={setSettings} />

          <PwaIosSettings
            settings={settings}
            pwaEnabled={pwaEnabled}
            onChange={setSettings}
            theme={storeInfo?.theme as StoreTheme | undefined}
          />

          <details className="rounded-xl border border-border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold text-foreground">
              {tPage('advanced')}
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">{tPage('advancedHint')}</p>
            <div className="mt-4">
              <PwaManifestPreview
                settings={settings}
                pwaEnabled={pwaEnabled}
                onChange={setSettings}
                theme={storeInfo?.theme as StoreTheme | undefined}
              />
            </div>
          </details>

          {message && <PwaStatusMessage message={message} />}
        </div>
      )}
      <StickySaveBar
        dirty={dirty || saving}
        onSave={handleSaveSettings}
        onReset={() => baseline && setSettings(JSON.parse(baseline))}
        saving={saving}
        saveLabel={tActions('save')}
      />
    </AdminLayout>
  );
}
