'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { AdminLayout } from '../../../../components/AdminLayout';

interface LoyaltySettings {
  pointsPerDinar: number;
  signupBonus: number;
  referralBonus: number;
  reviewBonus: number;
  birthdayBonus: number;
  tiers: {
    bronze: { minPoints: number; multiplier: number };
    silver: { minPoints: number; multiplier: number };
    gold: { minPoints: number; multiplier: number };
    platinum: { minPoints: number; multiplier: number };
  };
  pointsValue: number;
  minRedeemPoints: number;
  maxRedeemPercentage: number;
  expirationMonths: number;
}

interface LoyaltyMember {
  id: string;
  customerId: string;
  points: number;
  totalEarned: number;
  totalRedeemed: number;
  tier: string;
  customer: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
}

interface Stats {
  totalMembers: number;
  tierBreakdown: { bronze: number; silver: number; gold: number; platinum: number };
  totalPointsIssued: number;
  totalPointsRedeemed: number;
  outstandingPoints: number;
}

const TIER_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  bronze: { bg: 'bg-amber-100', text: 'text-amber-700', icon: 'bg-amber-500' },
  silver: { bg: 'bg-gray-100', text: 'text-gray-700', icon: 'bg-gray-400' },
  gold: { bg: 'bg-yellow-100', text: 'text-yellow-700', icon: 'bg-yellow-500' },
  platinum: { bg: 'bg-purple-100', text: 'text-purple-700', icon: 'bg-purple-500' },
};

const DEFAULT_SETTINGS: LoyaltySettings = {
  pointsPerDinar: 10,
  signupBonus: 100,
  referralBonus: 200,
  reviewBonus: 50,
  birthdayBonus: 500,
  tiers: {
    bronze: { minPoints: 0, multiplier: 1.0 },
    silver: { minPoints: 1000, multiplier: 1.25 },
    gold: { minPoints: 5000, multiplier: 1.5 },
    platinum: { minPoints: 15000, multiplier: 2.0 },
  },
  pointsValue: 1,
  minRedeemPoints: 500,
  maxRedeemPercentage: 50,
  expirationMonths: 12,
};

export default function LoyaltySettingsPage() {
  const params = useParams();
  const storeId = params.id as string;

  const [_storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [settings, setSettings] = useState<LoyaltySettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<Stats | null>(null);
  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [activeTab, setActiveTab] = useState<'settings' | 'members'>('settings');
  const [tierFilter, setTierFilter] = useState<string>('all');

  const [showAwardModal, setShowAwardModal] = useState(false);
  const [selectedMember, setSelectedMember] = useState<LoyaltyMember | null>(null);
  const [awardPoints, setAwardPoints] = useState('');
  const [awardReason, setAwardReason] = useState('');

  const fetchStoreName = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (res.ok) {
        const data = await res.json();
        setStoreName(data.data?.store?.name || '');
      }
    } catch (err) {
      console.error('Failed to fetch store name:', err);
    }
  }, [storeId]);

  const fetchSettings = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/settings`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setLoyaltyEnabled(data.data?.loyaltyEnabled || false);
        setSettings({ ...DEFAULT_SETTINGS, ...(data.data?.settings || {}) });
      }
    } catch (err) {
      console.error('Failed to fetch loyalty settings:', err);
    }
  }, [storeId]);

  const fetchStats = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/stats`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setStats(data.data?.stats || null);
      }
    } catch (err) {
      console.error('Failed to fetch loyalty stats:', err);
    }
  }, [storeId]);

  const fetchMembers = useCallback(async () => {
    try {
      const token = localStorage.getItem('authToken');
      const params = new URLSearchParams();
      if (tierFilter !== 'all') params.set('tier', tierFilter);

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/members?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setMembers(data.data?.members || []);
      }
    } catch (err) {
      console.error('Failed to fetch members:', err);
    }
  }, [storeId, tierFilter]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchStoreName(), fetchSettings(), fetchStats(), fetchMembers()]);
    setLoading(false);
  }, [fetchStoreName, fetchSettings, fetchStats, fetchMembers]);

  useEffect(() => {
    fetchAll();
  }, [storeId]);

  useEffect(() => {
    if (!loading) {
      fetchMembers();
    }
  }, [tierFilter]);

  const handleToggleEnabled = async () => {
    // Confirm before disabling to prevent accidental deactivation
    if (loyaltyEnabled) {
      const confirmed = window.confirm(
        'Disable the loyalty program? Customers will no longer earn or redeem points until you re-enable it.'
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/settings`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ loyaltyEnabled: !loyaltyEnabled }),
        }
      );
      if (res.ok) {
        setLoyaltyEnabled(!loyaltyEnabled);
      } else {
        alert('Failed to update loyalty program status. Please try again.');
      }
    } catch (err) {
      console.error('Failed to toggle loyalty:', err);
      alert('Failed to update loyalty program status. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/settings`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ settings }),
        }
      );
      if (!res.ok) {
        alert('Failed to save loyalty settings. Please try again.');
      }
    } catch (err) {
      console.error('Failed to save settings:', err);
      alert('Failed to save loyalty settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleAwardPoints = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMember) return;

    setSaving(true);
    try {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/${storeId}/loyalty/members/${selectedMember.customerId}/award`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            points: parseInt(awardPoints),
            type: 'earn_manual',
            description: awardReason || 'Manual points adjustment',
          }),
        }
      );
      if (res.ok) {
        setShowAwardModal(false);
        setSelectedMember(null);
        setAwardPoints('');
        setAwardReason('');
        fetchMembers();
        fetchStats();
      } else {
        alert('Failed to award points. Please try again.');
      }
    } catch (err) {
      console.error('Failed to award points:', err);
      alert('Failed to award points. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminLayout
      title="Loyalty Program"
      subtitle="Reward your customers with points and exclusive benefits"
      actions={
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">Program Status:</span>
          <button
            onClick={handleToggleEnabled}
            disabled={saving}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              loyaltyEnabled
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {loyaltyEnabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          {loyaltyEnabled && stats && (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Total Members</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalMembers}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Points Issued</p>
                <p className="text-2xl font-bold text-green-600">
                  {stats.totalPointsIssued.toLocaleString()}
                </p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Points Redeemed</p>
                <p className="text-2xl font-bold text-orange-600">
                  {stats.totalPointsRedeemed.toLocaleString()}
                </p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500">Outstanding</p>
                <p className="text-2xl font-bold text-blue-600">
                  {stats.outstandingPoints.toLocaleString()}
                </p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-sm text-gray-500 mb-2">Tier Breakdown</p>
                <div className="flex gap-1">
                  {Object.entries(stats.tierBreakdown).map(([tier, count]) => (
                    <div
                      key={tier}
                      className={`flex-1 h-2 rounded ${TIER_COLORS[tier]?.icon || 'bg-gray-300'}`}
                      style={{ flex: count || 0.1 }}
                      title={`${tier}: ${count}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-2 mb-6">
            <button
              onClick={() => setActiveTab('settings')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'settings'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Settings
            </button>
            <button
              onClick={() => setActiveTab('members')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === 'members'
                  ? 'bg-orange-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              disabled={!loyaltyEnabled}
            >
              Members
            </button>
          </div>

          {/* Settings Tab */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              {/* Earning Settings */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Point Earning</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Points per 1 KWD Spent
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={settings.pointsPerDinar}
                      onChange={e =>
                        setSettings({ ...settings, pointsPerDinar: parseInt(e.target.value) || 1 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Signup Bonus
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.signupBonus}
                      onChange={e =>
                        setSettings({ ...settings, signupBonus: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Referral Bonus
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.referralBonus}
                      onChange={e =>
                        setSettings({ ...settings, referralBonus: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Review Bonus
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.reviewBonus}
                      onChange={e =>
                        setSettings({ ...settings, reviewBonus: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Birthday Bonus
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.birthdayBonus}
                      onChange={e =>
                        setSettings({ ...settings, birthdayBonus: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                </div>
              </div>

              {/* Tier Settings */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Membership Tiers</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {(['bronze', 'silver', 'gold', 'platinum'] as const).map(tier => (
                    <div key={tier} className={`p-4 rounded-lg ${TIER_COLORS[tier].bg}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <div className={`w-3 h-3 rounded-full ${TIER_COLORS[tier].icon}`}></div>
                        <h3 className={`font-semibold capitalize ${TIER_COLORS[tier].text}`}>
                          {tier}
                        </h3>
                      </div>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Min Points</label>
                          <input
                            type="number"
                            min="0"
                            value={settings.tiers[tier].minPoints}
                            onChange={e =>
                              setSettings({
                                ...settings,
                                tiers: {
                                  ...settings.tiers,
                                  [tier]: {
                                    ...settings.tiers[tier],
                                    minPoints: parseInt(e.target.value) || 0,
                                  },
                                },
                              })
                            }
                            className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                            disabled={!loyaltyEnabled || tier === 'bronze'}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600 mb-1">Multiplier</label>
                          <input
                            type="number"
                            step="0.05"
                            min="1"
                            value={settings.tiers[tier].multiplier}
                            onChange={e =>
                              setSettings({
                                ...settings,
                                tiers: {
                                  ...settings.tiers,
                                  [tier]: {
                                    ...settings.tiers[tier],
                                    multiplier: parseFloat(e.target.value) || 1,
                                  },
                                },
                              })
                            }
                            className="w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                            disabled={!loyaltyEnabled}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Redemption Settings */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Redemption</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Point Value (fils)
                    </label>
                    <input
                      type="number"
                      min="1"
                      value={settings.pointsValue}
                      onChange={e =>
                        setSettings({ ...settings, pointsValue: parseInt(e.target.value) || 1 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      1 point = {settings.pointsValue} fils
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Min Points to Redeem
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.minRedeemPoints}
                      onChange={e =>
                        setSettings({ ...settings, minRedeemPoints: parseInt(e.target.value) || 0 })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Max % of Order
                    </label>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={settings.maxRedeemPercentage}
                      onChange={e =>
                        setSettings({
                          ...settings,
                          maxRedeemPercentage: parseInt(e.target.value) || 0,
                        })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Expiration (months)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={settings.expirationMonths}
                      onChange={e =>
                        setSettings({
                          ...settings,
                          expirationMonths: parseInt(e.target.value) || 0,
                        })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                      disabled={!loyaltyEnabled}
                    />
                    <p className="text-xs text-gray-500 mt-1">0 = never expires</p>
                  </div>
                </div>
              </div>

              {/* Save Button */}
              {loyaltyEnabled && (
                <div className="flex justify-end">
                  <button
                    onClick={handleSaveSettings}
                    disabled={saving}
                    className="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {saving && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    )}
                    Save Settings
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Members Tab */}
          {activeTab === 'members' && loyaltyEnabled && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              {/* Tier Filter */}
              <div className="flex gap-2 p-4 bg-gray-50 border-b border-gray-200">
                {['all', 'bronze', 'silver', 'gold', 'platinum'].map(t => (
                  <button
                    key={t}
                    onClick={() => setTierFilter(t)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
                      tierFilter === t
                        ? 'bg-orange-500 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Members Table */}
              {members.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg
                      className="w-8 h-8 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-2">No Members Yet</h3>
                  <p className="text-gray-600">
                    Customers will appear here when they join your loyalty program
                  </p>
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Member
                      </th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Tier
                      </th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Points Balance
                      </th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Total Earned
                      </th>
                      <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Total Redeemed
                      </th>
                      <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {members.map(member => (
                      <tr key={member.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <div>
                            <div className="font-medium text-gray-900">
                              {member.customer.firstName} {member.customer.lastName}
                            </div>
                            <div className="text-sm text-gray-500">{member.customer.email}</div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium capitalize ${TIER_COLORS[member.tier]?.bg} ${TIER_COLORS[member.tier]?.text}`}
                          >
                            {member.tier}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="font-medium text-gray-900">
                            {member.points.toLocaleString()}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-green-600">
                          +{member.totalEarned.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-orange-600">
                          -{member.totalRedeemed.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => {
                              setSelectedMember(member);
                              setShowAwardModal(true);
                            }}
                            className="text-orange-500 hover:text-orange-600 text-sm font-medium"
                          >
                            Award Points
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {/* Award Modal */}
      {showAwardModal && selectedMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Award Points</h2>
              <button
                onClick={() => {
                  setShowAwardModal(false);
                  setSelectedMember(null);
                }}
                className="p-2 text-gray-400 hover:text-gray-600"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <form onSubmit={handleAwardPoints} className="p-6 space-y-4">
              <div>
                <p className="text-sm text-gray-600 mb-4">
                  Award points to{' '}
                  <strong>
                    {selectedMember.customer.firstName} {selectedMember.customer.lastName}
                  </strong>
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Points <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={awardPoints}
                  onChange={e => setAwardPoints(e.target.value)}
                  placeholder="Enter points (negative to deduct)"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Reason</label>
                <input
                  type="text"
                  value={awardReason}
                  onChange={e => setAwardReason(e.target.value)}
                  placeholder="Optional reason for adjustment"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowAwardModal(false);
                    setSelectedMember(null);
                  }}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !awardPoints}
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-2"
                >
                  {saving && (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  )}
                  Award Points
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
