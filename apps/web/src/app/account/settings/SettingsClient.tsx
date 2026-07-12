'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@force/ui';
import { api } from '@/lib/api';
import { useLanguage } from '../../../contexts/LanguageContext';
import { useStoreUrl } from '../../../contexts/StoreContext';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export default function SettingsClient() {
  const router = useRouter();
  const { t } = useLanguage();
  const storeUrl = useStoreUrl();
  const [, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();

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
        toastSuccess('Profile saved', 'Your profile has been updated.');
      } else {
        const msg = result.error?.message || 'Failed to update profile';
        setMessage({ type: 'error', text: msg });
        toastError('Update failed', msg);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update profile. Please try again.' });
      toastError('Update failed', 'Failed to update profile. Please try again.');
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
        toastSuccess('Password updated', 'Your password has been changed.');
      } else {
        const msg = result.error?.message || 'Failed to update password';
        setMessage({ type: 'error', text: msg });
        toastError('Update failed', msg);
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to update password. Please try again.' });
      toastError('Update failed', 'Failed to update password. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExportData() {
    setIsExporting(true);
    setMessage(null);
    try {
      const result = await api.get<unknown>('/auth/me/export');
      if (!result.success || !result.data) {
        toastError(
          t('Download failed', 'فشل التنزيل'),
          t('Please try again.', 'يرجى المحاولة مرة أخرى.')
        );
        return;
      }
      // Trigger browser download of the JSON payload — name includes today's
      // date so the user knows the snapshot point.
      const blob = new Blob([JSON.stringify(result.data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-account-data-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toastSuccess(
        t('Data downloaded', 'تم تنزيل البيانات'),
        t('Your account data has been saved to your device.', 'تم حفظ بيانات حسابك على جهازك.')
      );
    } catch {
      toastError(
        t('Download failed', 'فشل التنزيل'),
        t('Please try again.', 'يرجى المحاولة مرة أخرى.')
      );
    } finally {
      setIsExporting(false);
    }
  }

  async function handleDeleteAccount() {
    setIsDeleting(true);
    setMessage(null);

    try {
      // Kuwait Law 13/2023 + GDPR Art. 17 compliant erasure: POST /auth/me/erase
      // irreversibly anonymizes PII while preserving anonymized order records
      // for Kuwait MOF tax retention. The old DELETE /auth/me was a soft-delete
      // (deletedAt timestamp) that left PII intact — NOT compliant.
      const result = await api.post<{ message: string }>('/auth/me/erase', {});
      if (result.success) {
        // Clear refresh token from localStorage (access token is HTTP-only cookie cleared by server)
        if (typeof window !== 'undefined') {
          localStorage.removeItem('refreshToken');
        }
        toastSuccess(
          t('Account deleted', 'تم حذف الحساب'),
          t('Your account data has been anonymized.', 'تم إخفاء بيانات حسابك.')
        );
        // Redirect to home after account deletion
        router.push(storeUrl('/'));
      } else {
        toastError(
          t('Delete failed', 'فشل الحذف'),
          result.error?.message ||
            t(
              'Failed to delete account. Please try again.',
              'فشل حذف الحساب. يرجى المحاولة مرة أخرى.'
            )
        );
        setMessage({
          type: 'error',
          text: result.error?.message || 'Failed to delete account. Please try again.',
        });
      }
    } catch {
      toastError(
        t('Delete failed', 'فشل الحذف'),
        t('Failed to delete account. Please try again.', 'فشل حذف الحساب. يرجى المحاولة مرة أخرى.')
      );
      setMessage({ type: 'error', text: 'Failed to delete account. Please try again.' });
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t('Account Settings', 'إعدادات الحساب')}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {t('Manage your profile and security', 'إدارة ملفك الشخصي والأمان')}
          </p>
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
        <h1 className="text-2xl font-bold text-foreground">
          {t(
            'Account Settings',
            '\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062d\u0633\u0627\u0628'
          )}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t(
            'Manage your profile and security',
            '\u0625\u062f\u0627\u0631\u0629 \u0645\u0644\u0641\u0643 \u0627\u0644\u0634\u062e\u0635\u064a \u0648\u0627\u0644\u0623\u0645\u0627\u0646'
          )}
        </p>
      </div>

      {message && (
        <div
          className={`rounded-lg p-4 ${
            message.type === 'success'
              ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Profile Settings */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t(
              'Profile Information',
              '\u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0634\u062e\u0635\u064a\u0629'
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Update your personal details',
              '\u062a\u062d\u062f\u064a\u062b \u0628\u064a\u0627\u0646\u0627\u062a\u0643 \u0627\u0644\u0634\u062e\u0635\u064a\u0629'
            )}
          </p>
        </div>
        <form onSubmit={handleProfileSubmit} className="p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t(
                'First Name',
                '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
              )}
              value={profileData.firstName}
              onChange={e => setProfileData({ ...profileData, firstName: e.target.value })}
              required
            />
            <Input
              label={t(
                'Last Name',
                '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u062e\u064a\u0631'
              )}
              value={profileData.lastName}
              onChange={e => setProfileData({ ...profileData, lastName: e.target.value })}
              required
            />
          </div>

          <Input
            label={t(
              'Email Address',
              '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
            )}
            type="email"
            value={profileData.email}
            onChange={e => setProfileData({ ...profileData, email: e.target.value })}
            required
          />

          <Input
            label={t('Phone Number', '\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062a\u0641')}
            type="tel"
            value={profileData.phone}
            onChange={e => setProfileData({ ...profileData, phone: e.target.value })}
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              {t(
                'Save Changes',
                '\u062d\u0641\u0638 \u0627\u0644\u062a\u063a\u064a\u064a\u0631\u0627\u062a'
              )}
            </Button>
          </div>
        </form>
      </div>

      {/* Password Settings */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t(
              'Change Password',
              '\u062a\u063a\u064a\u064a\u0631 \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Update your password to keep your account secure',
              '\u062d\u062f\u0651\u062b \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0644\u0644\u062d\u0641\u0627\u0638 \u0639\u0644\u0649 \u0623\u0645\u0627\u0646 \u062d\u0633\u0627\u0628\u0643'
            )}
          </p>
        </div>
        <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
          <Input
            label={t(
              'Current Password',
              '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062d\u0627\u0644\u064a\u0629'
            )}
            type="password"
            value={passwordData.currentPassword}
            onChange={e => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
            required
          />

          <Input
            label={t(
              'New Password',
              '\u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
            )}
            type="password"
            value={passwordData.newPassword}
            onChange={e => setPasswordData({ ...passwordData, newPassword: e.target.value })}
            required
          />

          <Input
            label={t(
              'Confirm New Password',
              '\u062a\u0623\u0643\u064a\u062f \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631 \u0627\u0644\u062c\u062f\u064a\u062f\u0629'
            )}
            type="password"
            value={passwordData.confirmPassword}
            onChange={e => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
            required
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              {t(
                'Update Password',
                '\u062a\u062d\u062f\u064a\u062b \u0643\u0644\u0645\u0629 \u0627\u0644\u0645\u0631\u0648\u0631'
              )}
            </Button>
          </div>
        </form>
      </div>

      {/* Privacy & data \u2014 GDPR Art. 20 / Kuwait Law 13/2023 portability right */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-muted/40 p-4">
          <h2 className="font-semibold text-foreground">
            {t(
              'Privacy & data',
              '\u0627\u0644\u062e\u0635\u0648\u0635\u064a\u0629 \u0648\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a'
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Download a copy of your data',
              '\u062a\u0646\u0632\u064a\u0644 \u0646\u0633\u062e\u0629 \u0645\u0646 \u0628\u064a\u0627\u0646\u0627\u062a\u0643'
            )}
          </p>
        </div>
        <div className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <p className="font-medium text-foreground">
                {t(
                  'Download my data',
                  '\u062a\u0646\u0632\u064a\u0644 \u0628\u064a\u0627\u0646\u0627\u062a\u064a'
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Get a JSON file with your profile, orders, addresses, and wishlist \u2014 exercise of your right to data portability under Kuwait Law 13/2023.',
                  '\u0627\u062d\u0635\u0644 \u0639\u0644\u0649 \u0645\u0644\u0641 JSON \u064a\u062d\u062a\u0648\u064a \u0639\u0644\u0649 \u0645\u0644\u0641\u0643 \u0627\u0644\u0634\u062e\u0635\u064a \u0648\u0637\u0644\u0628\u0627\u062a\u0643 \u0648\u0639\u0646\u0627\u0648\u064a\u0646\u0643 \u0648\u0645\u0641\u0636\u0644\u0627\u062a\u0643 \u2014 \u0645\u0645\u0627\u0631\u0633\u0629 \u062d\u0642\u0643 \u0641\u064a \u0646\u0642\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0648\u0641\u0642\u0627\u064b \u0644\u0644\u0642\u0627\u0646\u0648\u0646 \u0627\u0644\u0643\u0648\u064a\u062a\u064a 13/2023.'
                )}
              </p>
            </div>
            <Button variant="outline" onClick={handleExportData} isLoading={isExporting}>
              {t('Download', '\u062a\u0646\u0632\u064a\u0644')}
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl border border-destructive/30 bg-card shadow-sm">
        <div className="border-b border-destructive/30 bg-destructive/10 p-4">
          <h2 className="font-semibold text-destructive">
            {t('Danger Zone', '\u0645\u0646\u0637\u0642\u0629 \u0627\u0644\u062e\u0637\u0631')}
          </h2>
          <p className="text-sm text-destructive">
            {t(
              'Irreversible actions',
              '\u0625\u062c\u0631\u0627\u0621\u0627\u062a \u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u062a\u0631\u0627\u062c\u0639 \u0639\u0646\u0647\u0627'
            )}
          </p>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-foreground">
                {t('Delete Account', '\u062d\u0630\u0641 \u0627\u0644\u062d\u0633\u0627\u0628')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Permanently delete your account and all associated data',
                  '\u062d\u0630\u0641 \u062d\u0633\u0627\u0628\u0643 \u0646\u0647\u0627\u0626\u064a\u0627\u064b \u0648\u062c\u0645\u064a\u0639 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0645\u0631\u062a\u0628\u0637\u0629 \u0628\u0647'
                )}
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setShowDeleteConfirm(true)}
              isLoading={isDeleting}
            >
              {t('Delete Account', '\u062d\u0630\u0641 \u0627\u0644\u062d\u0633\u0627\u0628')}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Account Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl bg-card p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">
              {t('Delete Account', '\u062d\u0630\u0641 \u0627\u0644\u062d\u0633\u0627\u0628')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'Your name, email, phone, and addresses will be permanently anonymized. Your past order records will remain (with personal data removed) for tax-compliance retention per Kuwait Law 13/2023. You will be signed out immediately. This cannot be undone.',
                '\u0633\u064a\u062a\u0645 \u0625\u062e\u0641\u0627\u0621 \u0627\u0633\u0645\u0643 \u0648\u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0648\u0647\u0627\u062a\u0641\u0643 \u0648\u0639\u0646\u0627\u0648\u064a\u0646\u0643 \u0628\u0634\u0643\u0644 \u062f\u0627\u0626\u0645. \u0633\u062a\u0628\u0642\u0649 \u0633\u062c\u0644\u0627\u062a \u0637\u0644\u0628\u0627\u062a\u0643 \u0627\u0644\u0633\u0627\u0628\u0642\u0629 (\u0628\u062f\u0648\u0646 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0634\u062e\u0635\u064a\u0629) \u0644\u0623\u063a\u0631\u0627\u0636 \u0627\u0644\u0627\u0645\u062a\u062b\u0627\u0644 \u0627\u0644\u0636\u0631\u064a\u0628\u064a \u0648\u0641\u0642\u0627\u064b \u0644\u0644\u0642\u0627\u0646\u0648\u0646 \u0627\u0644\u0643\u0648\u064a\u062a\u064a 13/2023. \u0633\u064a\u062a\u0645 \u062a\u0633\u062c\u064a\u0644 \u062e\u0631\u0648\u062c\u0643 \u0641\u0648\u0631\u0627\u064b. \u0644\u0627 \u064a\u0645\u0643\u0646 \u0627\u0644\u062a\u0631\u0627\u062c\u0639 \u0639\u0646 \u0647\u0630\u0627 \u0627\u0644\u0625\u062c\u0631\u0627\u0621.'
              )}
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                {t('Cancel', '\u0625\u0644\u063a\u0627\u0621')}
              </Button>
              <Button variant="destructive" onClick={handleDeleteAccount} isLoading={isDeleting}>
                {t('Delete Account', '\u062d\u0630\u0641 \u0627\u0644\u062d\u0633\u0627\u0628')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
