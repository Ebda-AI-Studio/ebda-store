'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../components/AdminLayout';
import { RefundMethodModal } from './_components/RefundMethodModal';
import { RejectReasonModal } from './_components/RejectReasonModal';
import { ReturnDetailsDrawer } from './_components/ReturnDetailsDrawer';
import { ReturnStatusFilter } from './_components/ReturnStatusFilter';
import { ReturnsTable } from './_components/ReturnsTable';
import { StatsGrid } from './_components/StatsGrid';
import type { ReturnRecord } from './_components/types';
import { useReturns } from './_hooks/useReturns';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { useFeatures } from '../../../../hooks/useFeatures';

type StringResolver = (value: string | null) => void;

export default function ReturnsPage() {
  const { gate } = useRequireFeature('returns');
  // Customer wallet (D1): with it on, "Store credit" lands in the customer's
  // wallet — say so in the picker. Off (every store at launch): unchanged copy.
  const { isEnabled: isFeatureEnabled, isLoading: featuresLoading } = useFeatures();
  const walletEnabled = !featuresLoading && isFeatureEnabled('customer_wallet');

  const params = useParams();
  const storeId = params?.id as string;

  const tPage = useT('returns.page');

  const [selectedReturn, setSelectedReturn] = useState<ReturnRecord | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  // Promise resolvers held in refs so the modal flow can be modeled as an
  // async function in the hook. When the user confirms or cancels, we resolve
  // the pending promise; the hook then proceeds with (or aborts) the API call.
  const rejectResolverRef = useRef<StringResolver | null>(null);
  const refundResolverRef = useRef<StringResolver | null>(null);

  const requestRejectReason = useCallback(() => {
    setRejectOpen(true);
    return new Promise<string | null>(resolve => {
      rejectResolverRef.current = resolve;
    });
  }, []);

  const requestRefundMethod = useCallback(() => {
    setRefundOpen(true);
    return new Promise<string | null>(resolve => {
      refundResolverRef.current = resolve;
    });
  }, []);

  const handleRejectConfirm = (reason: string) => {
    setRejectOpen(false);
    rejectResolverRef.current?.(reason);
    rejectResolverRef.current = null;
  };

  const handleRejectCancel = () => {
    setRejectOpen(false);
    rejectResolverRef.current?.(null);
    rejectResolverRef.current = null;
  };

  const handleRefundConfirm = (method: string) => {
    setRefundOpen(false);
    refundResolverRef.current?.(method);
    refundResolverRef.current = null;
  };

  const handleRefundCancel = () => {
    setRefundOpen(false);
    refundResolverRef.current?.(null);
    refundResolverRef.current = null;
  };

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
    requestRejectReason,
    requestRefundMethod,
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

  if (gate) return gate;

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
        storeId={storeId}
        onClose={closeDetails}
        onApprove={handleApprove}
        onReject={handleReject}
        onMarkReceived={handleMarkReceived}
        onComplete={handleComplete}
      />

      <RejectReasonModal
        open={rejectOpen}
        onConfirm={handleRejectConfirm}
        onClose={handleRejectCancel}
      />

      <RefundMethodModal
        open={refundOpen}
        onConfirm={handleRefundConfirm}
        onClose={handleRefundCancel}
        walletEnabled={walletEnabled}
      />
    </AdminLayout>
  );
}
