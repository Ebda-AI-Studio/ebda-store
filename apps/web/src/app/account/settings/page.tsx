'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@force/ui';
import { api } from '@/lib/api';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [profileData, setProfileData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });

  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  useEffect(() => {
    fetchProfile();
  }, []);

  async function fetchProfile() {
    try {
      const result = await api.getProfile();
      if (result.success && result.data) {
        setUser(result.data.user);
        setProfileData({
          firstName: result.data.user.firstName || '',
          lastName: result.data.user.lastName || '',
          email: result.data.user.email || '',
          phone: result.data.user.phone || '',
        });
      }
    } catch (error) {
      console.error('Failed to fetch profile:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage(null);

    try {
      const result = await api.updateProfile({
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        phone: profileData.phone,
      });

      if (result.success && result.data) {
        setUser(result.data.user);
        setMessage({ type: 'success', text: 'Profile updated successfully!' });
      } else {
        setMessage({
          type: 'error',
          text: result.error?.message || 'Failed to update profile',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update profile. Please try again.' });
    } finally {
      setIsSaving(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage(null);

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords do not match' });
      setIsSaving(false);
      return;
    }

    if (passwordData.newPassword.length < 8) {
      setMessage({ type: 'error', text: 'Password must be at least 8 characters' });
      setIsSaving(false);
      return;
    }

    if (!/[A-Z]/.test(passwordData.newPassword)) {
      setMessage({ type: 'error', text: 'Password must contain at least one uppercase letter' });
      setIsSaving(false);
      return;
    }

    if (!/[a-z]/.test(passwordData.newPassword)) {
      setMessage({ type: 'error', text: 'Password must contain at least one lowercase letter' });
      setIsSaving(false);
      return;
    }

    if (!/[0-9]/.test(passwordData.newPassword)) {
      setMessage({ type: 'error', text: 'Password must contain at least one number' });
      setIsSaving(false);
      return;
    }

    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(passwordData.newPassword)) {
      setMessage({ type: 'error', text: 'Password must contain at least one special character' });
      setIsSaving(false);
      return;
    }

    try {
      const result = await api.changePassword(
        passwordData.currentPassword,
        passwordData.newPassword
      );

      if (result.success) {
        setMessage({ type: 'success', text: 'Password updated successfully!' });
        setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        setMessage({
          type: 'error',
          text: result.error?.message || 'Failed to update password',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update password. Please try again.' });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteAccount() {
    const confirmed = window.confirm(
      'Are you sure you want to permanently delete your account? This action cannot be undone and all your data will be lost.'
    );
    if (!confirmed) return;

    setIsDeleting(true);
    setMessage(null);

    try {
      const result = await api.delete<{ message: string }>('/auth/me');
      if (result.success) {
        // Clear all auth tokens from localStorage
        api.setToken(null);
        if (typeof window !== 'undefined') {
          localStorage.removeItem('refreshToken');
        }
        // Redirect to home after account deletion
        router.push('/');
      } else {
        setMessage({
          type: 'error',
          text: result.error?.message || 'Failed to delete account. Please try again.',
        });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to delete account. Please try again.' });
    } finally {
      setIsDeleting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account Settings</h1>
          <p className="mt-1 text-gray-500">Manage your profile and security</p>
        </div>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Account Settings</h1>
        <p className="mt-1 text-gray-500">Manage your profile and security</p>
      </div>

      {message && (
        <div
          className={`rounded-lg p-4 ${
            message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Profile Settings */}
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-gray-900">Profile Information</h2>
          <p className="text-sm text-gray-500">Update your personal details</p>
        </div>
        <form onSubmit={handleProfileSubmit} className="p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="First Name"
              value={profileData.firstName}
              onChange={e => setProfileData({ ...profileData, firstName: e.target.value })}
              required
            />
            <Input
              label="Last Name"
              value={profileData.lastName}
              onChange={e => setProfileData({ ...profileData, lastName: e.target.value })}
              required
            />
          </div>

          <Input
            label="Email Address"
            type="email"
            value={profileData.email}
            onChange={e => setProfileData({ ...profileData, email: e.target.value })}
            required
          />

          <Input
            label="Phone Number"
            type="tel"
            value={profileData.phone}
            onChange={e => setProfileData({ ...profileData, phone: e.target.value })}
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              Save Changes
            </Button>
          </div>
        </form>
      </div>

      {/* Password Settings */}
      <div className="rounded-xl border bg-white shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-gray-900">Change Password</h2>
          <p className="text-sm text-gray-500">Update your password to keep your account secure</p>
        </div>
        <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
          <Input
            label="Current Password"
            type="password"
            value={passwordData.currentPassword}
            onChange={e => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
            required
          />

          <Input
            label="New Password"
            type="password"
            value={passwordData.newPassword}
            onChange={e => setPasswordData({ ...passwordData, newPassword: e.target.value })}
            required
          />

          <Input
            label="Confirm New Password"
            type="password"
            value={passwordData.confirmPassword}
            onChange={e => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
            required
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              Update Password
            </Button>
          </div>
        </form>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl border border-red-200 bg-white shadow-sm">
        <div className="border-b border-red-200 bg-red-50 p-4">
          <h2 className="font-semibold text-red-800">Danger Zone</h2>
          <p className="text-sm text-red-600">Irreversible actions</p>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Delete Account</p>
              <p className="text-sm text-gray-500">
                Permanently delete your account and all associated data
              </p>
            </div>
            <Button variant="destructive" onClick={handleDeleteAccount} isLoading={isDeleting}>
              Delete Account
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
