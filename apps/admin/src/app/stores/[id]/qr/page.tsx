'use client';

import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { DesignControls } from './_components/DesignControls';
import { PreviewPanel } from './_components/PreviewPanel';
import { ScanStats } from './_components/ScanStats';
import { TargetPicker } from './_components/TargetPicker';
import { useQr } from './_hooks/useQr';

/**
 * QR codes (QR-1): design once, print for the store / a product / a category / the WhatsApp chat.
 * The code carries a short storefront link, so a printed code keeps working after a rename and
 * every scan is counted (`qr_scan_daily`). Design is saved in Store.settings.qr.
 */
export default function QrPage() {
  const params = useParams();
  const storeId = params.id as string;
  const t = useT('qr');
  const ta = useT('qr.actions');
  const q = useQr(storeId);

  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      {q.loading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : q.loadError || !q.store ? (
        <p role="alert" className="text-sm text-destructive-ink">
          {t('loadError')}
        </p>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="space-y-6">
            <div className="space-y-6 rounded-xl border border-border bg-card p-5 sm:p-6">
              <TargetPicker
                storeId={storeId}
                target={q.target}
                onChange={q.setTarget}
                hasWhatsapp={q.store.hasWhatsapp}
                link={q.payload}
              />
              <div className="border-t border-border pt-5">
                <DesignControls
                  design={q.design}
                  onChange={q.setDesign}
                  hasLogo={!!q.store.logo}
                  logoFailed={q.logoFailed}
                  whatsappText={q.whatsappText}
                  onWhatsappText={q.setWhatsappText}
                  showWhatsappText={q.target.kind === 'whatsapp'}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
                <button
                  type="button"
                  onClick={q.save}
                  disabled={q.saving || !q.dirty || !q.check?.ok}
                  className="h-10 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {q.saving ? ta('saving') : ta('save')}
                </button>
                <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                  {q.saveState === 'saved' && !q.dirty
                    ? ta('saved')
                    : q.saveState === 'error'
                      ? ta('saveError')
                      : q.dirty
                        ? ta('unsaved')
                        : ''}
                </p>
              </div>
            </div>
            <ScanStats rows={q.stats} />
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-xl border border-border bg-card p-5">
              <PreviewPanel
                scene={q.scene}
                payload={q.payload}
                check={q.check}
                logo={q.logo}
                nameForFile={q.target.label ?? q.store.name ?? q.target.kind}
              />
            </div>
          </aside>
        </div>
      )}
    </AdminLayout>
  );
}
