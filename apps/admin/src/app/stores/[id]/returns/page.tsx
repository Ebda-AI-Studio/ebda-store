'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { ReturnDetailsDrawer } from './_components/ReturnDetailsDrawer';
import { ReturnStatusFilter } from './_components/ReturnStatusFilter';
import { ReturnsTable } from './_components/ReturnsTable';
import { StatsGrid } from './_components/StatsGrid';
import type { ReturnRecord } from './_components/types';
import { useReturns } from './_hooks/useReturns';

export default function ReturnsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const { success: toastSuccess, error: showError } = useToast();

  const tPage = useT('returns.page');
  const tMessages = useT('returns.messages');

  const [selectedReturn, setSelectedReturn] = useState<ReturnRecord | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  // Memo so the hook's dependency-array-based effects don't re-run when the
  // parent re-renders (toast helpers are stable, but the messages object is
  // a plain literal).
  const messages = useMemo(
    () => ({
      approveSuccessTitle: tMessages('approveSuccessTitle'),
      approveSuccessBody: tMessages('approveSuccessBody'),
      approveErrorTitle: tMessages('approveErrorTitle'),
      approveErrorBody: tMessages('approveErrorBody'),
      rejectPrompt: tMessages('rejectPrompt'),
      rejectSuccessTitle: tMessages('rejectSuccessTitle'),
      rejectSuccessBody: tMessages('rejectSuccessBody'),
      rejectErrorTitle: tMessages('rejectErrorTitle'),
      rejectErrorBody: tMessages('rejectErrorBody'),
      receivedSuccessTitle: tMessages('receivedSuccessTitle'),
      receivedSuccessBody: tMessages('receivedSuccessBody'),
      receivedErrorTitle: tMessages('receivedErrorTitle'),
      receivedErrorBody: tMessages('receivedErrorBody'),
      completePrompt: tMessages('completePrompt'),
      completeSuccessTitle: tMessages('completeSuccessTitle'),
      completeSuccessBody: tMessages('completeSuccessBody'),
      completeErrorTitle: tMessages('completeErrorTitle'),
      completeErrorBody: tMessages('completeErrorBody'),
    }),
    [tMessages]
  );

  const {
    returns,
    stats,
    isLoading,
    filter,
    meta,
    approve,
    reject,
    markReceived,
    complete,
    changeFilter,
    setPage,
  } = useReturns({
    storeId,
    messages,
    onSuccess: toastSuccess,
    onError: showError,
  });

  const closeDetails = () => setShowDetails(false);

  const handleApprove = async (id: string) => {
    const ok = await approve(id);
    if (ok) closeDetails();
  };

  const handleReject = async (id: string) => {
    const ok = await reject(id);
    if (ok) closeDetails();
  };

  const handleMarkReceived = async (id: string) => {
    const ok = await markReceived(id);
    if (ok) closeDetails();
  };

  const handleComplete = async (id: string) => {
    const ok = await complete(id);
    if (ok) closeDetails();
  };

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <StatsGrid stats={stats} />

      <ReturnStatusFilter value={filter} onChange={changeFilter} />

      <ReturnsTable
        returns={returns}
        meta={meta}
        isLoading={isLoading}
        onSelect={ret => {
          setSelectedReturn(ret);
          setShowDetails(true);
        }}
        onApprove={handleApprove}
        onReject={handleReject}
        onMarkReceived={handleMarkReceived}
        onComplete={handleComplete}
        onPageChange={setPage}
      />

      <ReturnDetailsDrawer
        record={selectedReturn}
        open={showDetails}
        onClose={closeDetails}
        onApprove={handleApprove}
        onReject={handleReject}
        onMarkReceived={handleMarkReceived}
        onComplete={handleComplete}
      />
    </AdminLayout>
  );
}
