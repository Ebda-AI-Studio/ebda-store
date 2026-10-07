'use client';

/**
 * /stores/:id/builder — the visual builder (Phase 2). Full-screen, outside
 * AdminLayout (like Shopify's theme editor); AuthProvider still gates it.
 * The classic page builder (/page-builder) stays live until parity.
 */
import { useParams } from 'next/navigation';
import { useAuth } from '../../../../lib/auth';
import { useT } from '@/i18n/useT';
import { BuilderEditor } from './_components/BuilderEditor';

export default function BuilderPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { user, isLoading } = useAuth();
  const t = useT('builder');
  if (isLoading || !user)
    return (
      <div
        role="status"
        className="grid h-screen place-items-center bg-background text-sm text-muted-foreground"
      >
        {t('loading')}
      </div>
    );
  return <BuilderEditor storeId={storeId} />;
}
