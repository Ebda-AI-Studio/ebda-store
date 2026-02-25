'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@force/ui';
import { api } from '@/lib/api';
import { useAuth } from '../../../contexts/AuthContext';

export default function ProfilePage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth();
  const { success, error: toastError } = useToast();

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [profile, setProfile] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });

  const [passwords, setPasswords] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/auth/login?redirect=/account/profile');
      return;
    }

    if (user) {
      setProfile({
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        phone: user.phone || '',
      });
      setIsLoading(false);
    }
  }, [user, isAuthenticated, authLoading, router]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);

    try {
      const result = await api.put('/auth/me', {
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
      });

      if (result.success) {
        await refreshUser();
        success('Profile updated', 'Your profile has been saved successfully.');
      } else {
        toastError('Update failed', result.error?.message || 'Failed to update profile');
      }
    } catch {
      toastError('Update failed', 'An unexpected error occurred.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError('');

    if (passwords.newPassword !== passwords.confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }

    if (passwords.newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }

    setIsChangingPassword(true);

    try {
      const result = await api.post('/auth/change-password', {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });

      if (result.success) {
        success('Password changed', 'Your password has been updated.');
        setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        setPasswordError(result.error?.message || 'Failed to change password');
      }
    } catch {
      setPasswordError('An unexpected error occurred.');
    } finally {
      setIsChangingPassword(false);
    }
  }

  if (isLoading || authLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">My Profile</h1>
        <p className="mt-1 text-gray-500">Manage your personal information</p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Personal Information */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">Personal Information</h2>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="First Name"
                value={profile.firstName}
                onChange={e => setProfile({ ...profile, firstName: e.target.value })}
                required
              />
              <Input
                label="Last Name"
                value={profile.lastName}
                onChange={e => setProfile({ ...profile, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label="Email"
              type="email"
              value={profile.email}
              disabled
              className="bg-gray-50"
            />

            <Input
              label="Phone"
              type="tel"
              value={profile.phone}
              onChange={e => setProfile({ ...profile, phone: e.target.value })}
              placeholder="+965 XXXX XXXX"
            />

            <Button type="submit" isLoading={isSaving}>
              Save Changes
            </Button>
          </form>
        </div>

        {/* Change Password */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">Change Password</h2>

          {passwordError && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">
              {passwordError}
            </div>
          )}

          <form onSubmit={handleChangePassword} className="space-y-4">
            <Input
              label="Current Password"
              type="password"
              value={passwords.currentPassword}
              onChange={e => setPasswords({ ...passwords, currentPassword: e.target.value })}
              required
            />
            <Input
              label="New Password"
              type="password"
              value={passwords.newPassword}
              onChange={e => setPasswords({ ...passwords, newPassword: e.target.value })}
              required
            />
            <Input
              label="Confirm New Password"
              type="password"
              value={passwords.confirmPassword}
              onChange={e => setPasswords({ ...passwords, confirmPassword: e.target.value })}
              required
            />

            <Button type="submit" variant="outline" isLoading={isChangingPassword}>
              Update Password
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
