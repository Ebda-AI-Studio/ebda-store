'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { StickySaveBar } from '../../../../components/StickySaveBar';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut, apiPost } from '../../../../lib/api';
import { useLatestRequest } from '../../../../hooks/useLatestRequest';
import { LoyaltyStatsCards } from './_components/LoyaltyStatsCards';
import { PointEarningForm } from './_components/PointEarningForm';
import { TierSettings } from './_components/TierSettings';
import { RedemptionForm } from './_components/RedemptionForm';
import { MembersTable } from './_components/MembersTable';
import { AwardPointsModal } from './_components/AwardPointsModal';
import { DisableConfirmDialog } from './_components/DisableConfirmDialog';
import {
  DEFAULT_SETTINGS,
  type LoyaltyMember,
  type LoyaltySettings,
  type LoyaltyStats,
} from './_components/types';

import { useRequireFeature } from '../../../../hooks/useRequireFeature';

export default function LoyaltySettingsPage() {
  const { gate } = useRequireFeature('loyalty');

  const params = useParams();
  const storeId = params.id as string;
  const tPage = useT('loyalty.page');
  const tToast = useT('loyalty.toast');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [settings, setSettings] = useState<LoyaltySettings>(DEFAULT_SETTINGS);
  // Last saved copy: the sticky bar (one Save for all three forms) shows only while this differs.
  const [savedSettings, setSavedSettings] = useState<LoyaltySettings>(DEFAULT_SETTINGS);
  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const [stats, setStats] = useState<LoyaltyStats | null>(null);
  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [activeTab, setActiveTab] = useState<'settings' | 'members'>('settings');
  const [tierFilter, setTierFilter] = useState<string>('all');
  // Bumped after an award: the members effect owns EVERY refetch, so it reads the CURRENT tier
  // filter instead of the one captured when the award handler's closure rendered (issues 2443, 2451).
  const [refreshKey, setRefreshKey] = useState(0);
  // Latest-request-wins: a slower response for the previous tier must not repaint its members.
  const beginRequest = useLatestRequest();

  const [showAwardModal, setShowAwardModal] = useState(false);
  const [selectedMember, setSelectedMember] = useState<LoyaltyMember | null>(null);
  const [awardPoints, setAwardPoints] = useState('');
  const [awardReason, setAwardReason] = useState('');
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const { success: toastSuccess, error: showError } = useToast();

  const fetchSettings = useCallback(async () => {
    const { data } = await apiGet<{ loyaltyEnabled: boolean; settings: LoyaltySettings }>(
      `/api/v1/stores/${storeId}/loyalty/settings`
    );
    if (data) {
      setLoyaltyEnabled(data.loyaltyEnabled || false);
      const loaded = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      setSettings(loaded);
      setSavedSettings(loaded);
    }
  }, [storeId]);

  const fetchStats = useCallback(async () => {
    const { data } = await apiGet<{ stats: LoyaltyStats }>(
      `/api/v1/stores/${storeId}/loyalty/stats`
    );
    if (data) {
      setStats(data.stats || null);
    }
  }, [storeId]);

  const fetchMembers = useCallback(async () => {
    const isLatest = beginRequest();
    const qs = new URLSearchParams();
    if (tierFilter !== 'all') qs.set('tier', tierFilter);

    const { data } = await apiGet<{ members: LoyaltyMember[] }>(
      `/api/v1/stores/${storeId}/loyalty/members?${qs}`
    );
    if (!isLatest()) return;
    if (data) {
      setMembers(data.members || []);
    }
  }, [storeId, tierFilter, beginRequest]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchSettings(), fetchStats(), fetchMembers()]);
    setLoading(false);
  }, [fetchSettings, fetchStats, fetchMembers]);

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    if (!loading) {
      fetchMembers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierFilter, refreshKey]);

  const handleToggleEnabled = async () => {
    // Confirm before disabling to prevent accidental deactivation
    if (loyaltyEnabled) {
      setShowDisableConfirm(true);
      return;
    }
    await performToggle();
  };

  const performToggle = async () => {
    setShowDisableConfirm(false);
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/loyalty/settings`, {
        loyaltyEnabled: !loyaltyEnabled,
      });
      if (!error) {
        setLoyaltyEnabled(!loyaltyEnabled);
        toastSuccess(
          tToast('updatedTitle'),
          loyaltyEnabled ? tToast('disabledDescription') : tToast('enabledDescription')
        );
      } else {
        showError(tToast('errorTitle'), tToast('toggleFailed'));
      }
    } catch (err) {
      console.error('Failed to toggle loyalty:', err);
      showError(tToast('errorTitle'), tToast('toggleFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/loyalty/settings`, { settings });
      if (!error) {
        setSavedSettings(settings);
        toastSuccess(tToast('savedTitle'), tToast('savedDescription'));
      } else {
        showError(tToast('errorTitle'), tToast('saveFailed'));
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      showError(tToast('errorTitle'), tToast('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleAwardPoints = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMember) return;

    setSaving(true);
    try {
      const { error } = await apiPost(
        `/api/v1/stores/${storeId}/loyalty/members/${selectedMember.customerId}/award`,
        {
          points: parseInt(awardPoints),
          type: 'earn_manual',
          description: awardReason || 'Manual points adjustment',
        }
      );
      if (!error) {
        toastSuccess(
          tToast('awardedTitle'),
          tToast('awardedDescription', { name: selectedMember.customer.firstName })
        );
        setShowAwardModal(false);
        setSelectedMember(null);
        setAwardPoints('');
        setAwardReason('');
        setRefreshKey(k => k + 1);
        fetchStats();
      } else {
        showError(tToast('errorTitle'), tToast('awardFailed'));
      }
    } catch (err) {
      console.error('Failed to award points:', err);
      showError(tToast('errorTitle'), tToast('awardFailed'));
    } finally {
      setSaving(false);
    }
  };

  const updateSettings = (patch: Partial<LoyaltySettings>) =>
    setSettings(prev => ({ ...prev, ...patch }));

  if (gate) return gate;

  return (
    <AdminLayout
      title={tPage('title')}
      subtitle={tPage('subtitle')}
      actions={
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{tPage('programStatus')}</span>
          <button
            type="button"
            onClick={handleToggleEnabled}
            disabled={saving}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              loyaltyEnabled
                ? 'bg-success/10 text-success-ink dark:bg-success/30 dark:text-success-ink hover:bg-success/20'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {loyaltyEnabled ? tPage('enabled') : tPage('disabled')}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <>
          {loyaltyEnabled && stats && <LoyaltyStatsCards stats={stats} />}

          <div className="flex gap-2 mb-6">
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'settings'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
            >
              {tPage('tabs.settings')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('members')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'members'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-muted/80'
              }`}
              disabled={!loyaltyEnabled}
            >
              {tPage('tabs.members')}
            </button>
            {/* Transactions sub-page link */}
            <Link
              href={`/stores/${storeId}/loyalty/transactions`}
              className="ms-auto px-4 py-2 rounded-lg font-medium text-sm bg-muted text-foreground hover:bg-muted/80 transition-colors inline-flex items-center gap-1.5"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              {tPage('transactions')}
            </Link>
          </div>

          {activeTab === 'settings' && (
            <div className="space-y-6">
              <PointEarningForm
                settings={settings}
                disabled={!loyaltyEnabled}
                onChange={updateSettings}
              />
              <TierSettings
                settings={settings}
                disabled={!loyaltyEnabled}
                onChange={updateSettings}
              />
              <RedemptionForm
                settings={settings}
                disabled={!loyaltyEnabled}
                onChange={updateSettings}
              />

              {loyaltyEnabled && (
                <StickySaveBar
                  dirty={dirty}
                  saving={saving}
                  onSave={handleSaveSettings}
                  onReset={() => setSettings(savedSettings)}
                  saveLabel={tPage('saveSettings')}
                />
              )}
            </div>
          )}

          {activeTab === 'members' && loyaltyEnabled && (
            <MembersTable
              members={members}
              tierFilter={tierFilter}
              onTierFilterChange={setTierFilter}
              onAwardClick={member => {
                setSelectedMember(member);
                setShowAwardModal(true);
              }}
            />
          )}
        </>
      )}

      {showDisableConfirm && (
        <DisableConfirmDialog
          saving={saving}
          onCancel={() => setShowDisableConfirm(false)}
          onConfirm={performToggle}
        />
      )}

      {showAwardModal && selectedMember && (
        <AwardPointsModal
          member={selectedMember}
          points={awardPoints}
          reason={awardReason}
          saving={saving}
          onPointsChange={setAwardPoints}
          onReasonChange={setAwardReason}
          onClose={() => {
            setShowAwardModal(false);
            setSelectedMember(null);
          }}
          onSubmit={handleAwardPoints}
        />
      )}
    </AdminLayout>
  );
}
