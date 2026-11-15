'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@ebda/ui';
import { api } from '@/lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useStoreUrl } from '../../../contexts/StoreContext';

import { REGION } from '@ebda/shared';
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
        success(
          t('Profile updated', 'الملف الشخصي اتحدّث'),
          t('Your profile has been saved successfully.', 'ملفك الشخصي اتحفظ.')
        );
      } else {
        toastError(
          t('Update failed', 'معرفناش نحدّث'),
          result.error?.message || t('Failed to update profile', 'معرفناش نحدّث الملف الشخصي')
        );
      }
    } catch {
      toastError(
        t('Update failed', 'معرفناش نحدّث'),
        t('An unexpected error occurred.', 'حصل خطأ مش متوقع.')
      );
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
        success(
          t('Password changed', 'كلمة المرور اتغيّرت'),
          t('Your password has been updated.', 'كلمة المرور اتحدّثت.')
        );
        setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      } else {
        setPasswordError(
          result.error?.message || t('Failed to change password', 'معرفناش نغيّر كلمة المرور')
        );
      }
    } catch {
      setPasswordError(t('An unexpected error occurred.', 'حصل خطأ مش متوقع.'));
    } finally {
      setIsChangingPassword(false);
    }
  }

  if (isLoading || authLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">{t('My Profile', 'ملفي الشخصي')}</h1>
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('My Profile', 'ملفي الشخصي')}</h1>
        <p className="mt-1 text-muted-foreground">
          {t('Manage your personal information', 'إدارة معلوماتك الشخصية')}
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* Personal Information */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-6">
            {t('Personal Information', 'المعلومات الشخصية')}
          </h2>

          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label={t('First Name', 'الاسم الأول')}
                value={profile.firstName}
                onChange={e => setProfile({ ...profile, firstName: e.target.value })}
                required
              />
              <Input
                label={t('Last Name', 'الاسم الأخير')}
                value={profile.lastName}
                onChange={e => setProfile({ ...profile, lastName: e.target.value })}
                required
              />
            </div>

            <Input
              label={t('Email', 'البريد الإلكتروني')}
              type="email"
              value={profile.email}
              disabled
              className="bg-muted"
            />

            <Input
              label={t('Phone', 'رقم الموبايل')}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={profile.phone}
              onChange={e => setProfile({ ...profile, phone: e.target.value })}
              placeholder={REGION.phone.placeholderIntl}
            />

            <Button type="submit" isLoading={isSaving}>
              {t('Save Changes', 'حفظ التغييرات')}
            </Button>
          </form>
        </div>

        {/* Change Password */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground mb-6">
            {t('Change Password', 'تغيير كلمة المرور')}
          </h2>

          {passwordError && (
            <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
              {passwordError}
            </div>
          )}

          <form onSubmit={handleChangePassword} className="space-y-4">
            <Input
              label={t('Current Password', 'كلمة المرور الحالية')}
              type="password"
              value={passwords.currentPassword}
              onChange={e => setPasswords({ ...passwords, currentPassword: e.target.value })}
              required
            />
            <Input
              label={t('New Password', 'كلمة المرور الجديدة')}
              type="password"
              value={passwords.newPassword}
              onChange={e => setPasswords({ ...passwords, newPassword: e.target.value })}
              required
            />
            <Input
              label={t('Confirm New Password', 'تأكيد كلمة المرور الجديدة')}
              type="password"
              value={passwords.confirmPassword}
              onChange={e => setPasswords({ ...passwords, confirmPassword: e.target.value })}
              required
            />

            <Button type="submit" variant="outline" isLoading={isChangingPassword}>
              {t('Update Password', 'تحديث كلمة المرور')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
