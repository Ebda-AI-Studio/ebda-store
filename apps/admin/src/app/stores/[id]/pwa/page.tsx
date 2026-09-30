'use client';

import { useParams } from 'next/navigation';
import type { StoreTheme } from '@force/shared';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
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

  const handleSaveSettings = () => {
    saveSettings(tMessages('saveSuccess'), tMessages('saveError'));
  };

  const handlePopulate = () => {
    populateFromStore(tMessages('populated'));
  };

  if (gate) return gate;

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{tActions('statusLabel')}</span>
          <button
            type="button"
            onClick={handleToggleEnabled}
            disabled={saving}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              pwaEnabled
                ? 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success hover:bg-success/20'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {pwaEnabled ? tActions('enabled') : tActions('disabled')}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="space-y-6">
          {storeInfo && <AutoPopulateBanner storeInfo={storeInfo} onPopulate={handlePopulate} />}

          <PwaBenefits />

          <PwaBranding settings={settings} pwaEnabled={pwaEnabled} onChange={setSettings} />

          <PwaManifestPreview
            settings={settings}
            pwaEnabled={pwaEnabled}
            onChange={setSettings}
            theme={storeInfo?.theme as StoreTheme | undefined}
          />

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

          {message && <PwaStatusMessage message={message} />}

          {pwaEnabled && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={saving}
                className="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {saving && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                {tActions('save')}
              </button>
            </div>
          )}
        </div>
      )}
    </AdminLayout>
  );
}
