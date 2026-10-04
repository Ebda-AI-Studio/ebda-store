'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@force/ui';
import { api } from '@/lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useStoreUrl } from '../../../contexts/StoreContext';

import { REGION } from '@force/shared';
export default function ProfileClient() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading, refreshUser } = useAuth();
  const { t } = useLanguage();
  const { success, error: toastError } = useToast();
  const storeUrl = useStoreUrl();

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
      router.push(storeUrl('/auth/login?redirect=/account/profile'));
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
        <h1 className="text-2xl font-bold text-foreground">
          {t('My Profile', '\u0645\u0644\u0641\u064a \u0627\u0644\u0634\u062e\u0635\u064a')}
        </h1>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('My Profile', '\u0645\u0644\u0641\u064a \u0627\u0644\u0634\u062e\u0635\u064a')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t(
            'Manage your personal information',
            '\u0625\u062f\u0627\u0631\u0629 \u0645\u0639\u0644\u0648\u0645\u0627\u062a\u0643 \u0627\u0644\u0634\u062e\u0635\u064a\u0629'
          )}
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Personal Information */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-6">
            {t(
              'Personal Information',
              '\u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0634\u062e\u0635\u064a\u0629'
            )}
          </h2>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t(
                  'First Name',
                  '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
                )}
                value={profile.firstName}
                onChange={e => setProfile({ ...profile, firstName: e.target.value })}
                required
              />
              <Input
                label={t(
                  'Last Name',
                  '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u062e\u064a\u0631'
                )}
                value={profile.lastName}
                onChange={e => setProfile({ ...profile, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label={t(
                'Email',
                '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
              )}
              type="email"
              value={profile.email}
              disabled
              className="bg-muted"
            />

            <Input
              label={t('Phone', '\u0627\u0644\u0647\u0627\u062a\u0641')}
              type="tel"
              value={profile.phone}
              onChange={e => setProfile({ ...profile, phone: e.target.value })}
              placeholder={REGION.phone.placeholderIntl}
            />

            <Button type="submit" isLoading={isSaving}>
              {t(
                'Save Changes',
                '\u062d\u0641\u0638 \u0627\u0644\u062a\u063a\u064a\u064a\u0631\u0627\u062a'
              )}
            </Button>
          </form>
        </div>

        {/* Change Password */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-6">
            {t(
              'Change Password',
              '\u062a\u063a\u064a\u064a\u0631 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
            )}
          </h2>

          {passwordError && (
            <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
              {passwordError}
            </div>
          )}

          <form onSubmit={handleChangePassword} className="space-y-4">
            <Input
              label={t(
                'Current Password',
                '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062d\u0627\u0644\u064a\u0629'
              )}
              type="password"
              value={passwords.currentPassword}
              onChange={e => setPasswords({ ...passwords, currentPassword: e.target.value })}
              required
            />
            <Input
              label={t(
                'New Password',
                '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
              )}
              type="password"
              value={passwords.newPassword}
              onChange={e => setPasswords({ ...passwords, newPassword: e.target.value })}
              required
            />
            <Input
              label={t(
                'Confirm New Password',
                '\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
              )}
              type="password"
              value={passwords.confirmPassword}
              onChange={e => setPasswords({ ...passwords, confirmPassword: e.target.value })}
              required
            />

            <Button type="submit" variant="outline" isLoading={isChangingPassword}>
              {t(
                'Update Password',
                '\u062a\u062d\u062f\u064a\u062b \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
