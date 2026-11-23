'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@ebda/ui';
import { api, type SmsConsentResponse } from '@/lib/api';
import { useLanguage, translations } from '../../../contexts/LanguageContext';
import { useStoreUrl } from '../../../contexts/StoreContext';
import PasskeysCard from '../../../components/PasskeysCard';
import { useWallet } from '../../../hooks/useWallet';
import { useLocalePrice } from '../../../hooks/useLocalePrice';

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
  const { wallet } = useWallet();
  const money = useLocalePrice();
  const walletBalance = wallet?.balance ?? 0;
  const [forfeitAck, setForfeitAck] = useState(false);
  const [, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();
  // SMS offers (issue 206). Null until loaded; the card renders only when the
  // store can send promotional SMS, or while consent is still active (so it
  // can always be withdrawn). A store without SMS marketing shows nothing.
  const [smsConsent, setSmsConsent] = useState<SmsConsentResponse | null>(null);
  const [isSavingSms, setIsSavingSms] = useState(false);

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
    fetchSmsConsent();
  }, []);

  async function fetchSmsConsent() {
    try {
      const result = await api.getSmsConsent();
      if (result.success && result.data) setSmsConsent(result.data);
    } catch {
      // No card on failure — never a wrong state.
    }
  }

  async function handleSmsConsentChange(optIn: boolean) {
    setIsSavingSms(true);
    try {
      const result = await api.setSmsConsent(optIn);
      if (result.success && result.data) {
        setSmsConsent(prev => (prev ? { ...prev, consent: result.data!.consent } : prev));
      } else {
        toastError(
          t('SMS offers', translations['SMS offers']),
          result.error?.message || t('Failed to update', 'معرفناش نحدّث')
        );
      }
    } catch {
      toastError(
        t('SMS offers', translations['SMS offers']),
        t('Failed to update', 'معرفناش نحدّث')
      );
    } finally {
      setIsSavingSms(false);
    }
  }

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
        // The SMS-offers card shows the profile phone; re-read it.
        fetchSmsConsent();
        setMessage({ type: 'success', text: 'Profile updated successfully!' });
        toastSuccess(
          t('Profile saved', 'الملف الشخصي اتحفظ'),
          t('Your profile has been updated.', 'ملفك الشخصي اتحدّث.')
        );
      } else {
        const msg =
          result.error?.message || t('Failed to update profile', 'معرفناش نحدّث الملف الشخصي');
        setMessage({ type: 'error', text: msg });
        toastError(t('Update failed', 'معرفناش نحدّث'), msg);
      }
    } catch {
      setMessage({
        type: 'error',
        text: t(
          'Failed to update profile. Please try again.',
          'معرفناش نحدّث الملف الشخصي. جرّب تاني.'
        ),
      });
      toastError(
        t('Update failed', 'معرفناش نحدّث'),
        t('Failed to update profile. Please try again.', 'معرفناش نحدّث الملف الشخصي. جرّب تاني.')
      );
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
        toastSuccess(
          t('Password updated', 'كلمة المرور اتحدّثت'),
          t('Your password has been changed.', 'كلمة المرور اتغيّرت.')
        );
      } else {
        const msg = result.error?.message || 'Failed to update password';
        setMessage({ type: 'error', text: msg });
        toastError(t('Update failed', 'معرفناش نحدّث'), msg);
      }
    } catch {
      setMessage({
        type: 'error',
        text: t(
          'Failed to update password. Please try again.',
          'معرفناش نحدّث كلمة المرور. جرّب تاني.'
        ),
      });
      toastError(
        t('Update failed', 'معرفناش نحدّث'),
        t('Failed to update password. Please try again.', 'معرفناش نحدّث كلمة المرور. جرّب تاني.')
      );
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
        toastError(t('Download failed', 'فشل التنزيل'), t('Please try again.', 'جرّب تاني.'));
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
        t('Data downloaded', 'البيانات اتنزّلت'),
        t('Your account data has been saved to your device.', 'بيانات حسابك اتحفظت على جهازك.')
      );
    } catch {
      toastError(t('Download failed', 'فشل التنزيل'), t('Please try again.', 'جرّب تاني.'));
    } finally {
      setIsExporting(false);
    }
  }

  /** The API answers a closure refusal with a stable code; the text is chosen here, in the shopper's language. */
  function closeAccountError(code: string | undefined): string {
    switch (code) {
      case 'ACCOUNT_HAS_OPEN_ORDERS':
        return t(
          'You still have an order in progress. Close your account after it is delivered or cancelled.',
          'لسه عندك طلب شغال. اقفل حسابك بعد ما يوصلك أو يتلغي.'
        );
      case 'ACCOUNT_HAS_OPEN_RETURN':
        return t(
          'You still have a return or refund in progress. Close your account once it is settled.',
          'لسه عندك مرتجع أو استرداد جاري. اقفل حسابك بعد ما يخلص.'
        );
      case 'ERASURE_INCOMPLETE':
        return t(
          'We could not finish closing your account. It is locked and the closure will be completed shortly. Contact support if it is not.',
          'معرفناش نكمّل قفل حسابك. الحساب اتقفل مؤقتًا وهنكمّل القفل خلال وقت قصير. كلّم الدعم لو ما اتكملش.'
        );
      default:
        return t('Failed to delete account. Please try again.', 'حذف الحساب منفعش. جرّب تاني.');
    }
  }

  async function handleDeleteAccount() {
    setIsDeleting(true);
    setMessage(null);

    try {
      // GDPR Art. 17 and applicable GCC data-protection law (see
      // docs/privacy/data-map.md) compliant erasure: POST /auth/me/erase
      // irreversibly anonymizes PII while preserving anonymized order records
      // for Egypt MOF tax retention. The old DELETE /auth/me was a soft-delete
      // (deletedAt timestamp) that left PII intact — NOT compliant.
      const result = await api.post<{ message: string }>('/auth/me/erase', {});
      if (result.success) {
        // Clear refresh token from localStorage (access token is HTTP-only cookie cleared by server)
        if (typeof window !== 'undefined') {
          localStorage.removeItem('refreshToken');
        }
        toastSuccess(
          t('Account deleted', 'الحساب اتمسح'),
          t('Your account data has been anonymized.', 'بياناتك الشخصية اتشالت من الحساب.')
        );
        // Redirect to home after account deletion
        router.push(storeUrl('/'));
      } else {
        const text = closeAccountError(result.error?.code);
        toastError(t('Delete failed', 'فشل الحذف'), text);
        setMessage({ type: 'error', text });
      }
    } catch {
      toastError(
        t('Delete failed', 'فشل الحذف'),
        t('Failed to delete account. Please try again.', 'حذف الحساب منفعش. جرّب تاني.')
      );
      setMessage({ type: 'error', text: closeAccountError(undefined) });
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
          {t('Account Settings', 'إعدادات الحساب')}
        </h1>
        <p className="mt-1 text-muted-foreground">
          {t('Manage your profile and security', 'إدارة ملفك الشخصي والأمان')}
        </p>
      </div>

      {message && (
        <div
          className={`rounded-lg p-4 ${
            message.type === 'success'
              ? 'bg-success/10 text-success-ink'
              : 'bg-destructive/10 text-destructive-ink'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Profile Settings */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t('Profile Information', 'المعلومات الشخصية')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('Update your personal details', 'تحديث بياناتك الشخصية')}
          </p>
        </div>
        <form onSubmit={handleProfileSubmit} className="p-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label={t('First Name', 'الاسم الأول')}
              value={profileData.firstName}
              onChange={e => setProfileData({ ...profileData, firstName: e.target.value })}
              required
            />
            <Input
              label={t('Last Name', 'الاسم الأخير')}
              value={profileData.lastName}
              onChange={e => setProfileData({ ...profileData, lastName: e.target.value })}
              required
            />
          </div>

          <Input
            label={t('Email Address', 'البريد الإلكتروني')}
            type="email"
            value={profileData.email}
            onChange={e => setProfileData({ ...profileData, email: e.target.value })}
            required
          />

          <Input
            label={t('Phone Number', 'رقم الموبايل')}
            type="tel"
            value={profileData.phone}
            onChange={e => setProfileData({ ...profileData, phone: e.target.value })}
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              {t('Save Changes', 'حفظ التغييرات')}
            </Button>
          </div>
        </form>
      </div>

      {/* Password Settings */}
      <div className="rounded-xl border bg-card shadow-sm">
        <div className="border-b p-4">
          <h2 className="font-semibold text-foreground">
            {t('Change Password', 'تغيير كلمة المرور')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              'Update your password to keep your account secure',
              'غيّر كلمة المرور عشان حسابك يفضل في أمان'
            )}
          </p>
        </div>
        <form onSubmit={handlePasswordSubmit} className="p-6 space-y-4">
          <Input
            label={t('Current Password', 'كلمة المرور الحالية')}
            type="password"
            value={passwordData.currentPassword}
            onChange={e => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
            required
          />

          <Input
            label={t('New Password', 'كلمة المرور الجديدة')}
            type="password"
            value={passwordData.newPassword}
            onChange={e => setPasswordData({ ...passwordData, newPassword: e.target.value })}
            required
          />

          <Input
            label={t('Confirm New Password', 'تأكيد كلمة المرور الجديدة')}
            type="password"
            value={passwordData.confirmPassword}
            onChange={e => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
            required
          />

          <div className="pt-4">
            <Button type="submit" isLoading={isSaving}>
              {t('Update Password', 'تحديث كلمة المرور')}
            </Button>
          </div>
        </form>
      </div>

      {/* Passkeys: optional Face ID / passkey sign-in for this store */}
      <PasskeysCard />

      {/* SMS offers (issue 206) */}
      {smsConsent && (smsConsent.available || smsConsent.consent.status === 'granted') && (
        <div className="rounded-xl border bg-card shadow-sm" data-sms-consent-card>
          <div className="border-b p-4">
            <h2 className="font-semibold text-foreground">
              {t('SMS offers', translations['SMS offers'])}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t(
                'Get offers and reminders from this store by SMS.',
                translations['Get offers and reminders from this store by SMS.']
              )}{' '}
              {t(
                'Order updates are not affected.',
                translations['Order updates are not affected.']
              )}
            </p>
          </div>
          <div className="p-6">
            {smsConsent.consent.status === 'granted' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-foreground">
                  {t(
                    'You are receiving SMS offers.',
                    translations['You are receiving SMS offers.']
                  )}
                  {smsConsent.consent.phone && (
                    <span className="block text-xs text-muted-foreground">
                      {t('Offers will be sent to', translations['Offers will be sent to'])}{' '}
                      <span dir="ltr">{smsConsent.consent.phone}</span>
                    </span>
                  )}
                </p>
                <Button
                  variant="outline"
                  onClick={() => handleSmsConsentChange(false)}
                  isLoading={isSavingSms}
                >
                  {t('Stop SMS offers', translations['Stop SMS offers'])}
                </Button>
              </div>
            ) : smsConsent.phone ? (
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={isSavingSms}
                  onChange={e => e.target.checked && handleSmsConsentChange(true)}
                  className="mt-0.5 h-6 w-6 shrink-0 rounded border-input text-primary accent-primary focus:ring-2 focus:ring-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {t('Send me offers by SMS', translations['Send me offers by SMS'])}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('Offers will be sent to', translations['Offers will be sent to'])}{' '}
                    <span dir="ltr">{smsConsent.phone}</span>
                  </span>
                </span>
              </label>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t(
                  'Add a phone number to your profile to get SMS offers.',
                  translations['Add a phone number to your profile to get SMS offers.']
                )}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Privacy & data — GDPR Art. 20 / applicable GCC data-protection law portability right (see docs/legal/gcc-data-protection.md) */}
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border bg-muted/40 p-4">
          <h2 className="font-semibold text-foreground">
            {t('Privacy & data', 'الخصوصية والبيانات')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('Download a copy of your data', 'تنزيل نسخة من بياناتك')}
          </p>
        </div>
        <div className="p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <p className="font-medium text-foreground">
                {t('Download my data', 'تنزيل بياناتي')}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Get a JSON file with your profile, orders, addresses, and wishlist — exercise your right to data portability under applicable data-protection law.',
                  'نزّل ملف JSON فيه ملفك الشخصي وطلباتك وعناوينك ومفضلاتك — ده حقك في نقل بياناتك حسب قوانين حماية البيانات.'
                )}
              </p>
            </div>
            <Button variant="outline" onClick={handleExportData} isLoading={isExporting}>
              {t('Download', 'تنزيل')}
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="rounded-xl border border-destructive/30 bg-card shadow-sm">
        <div className="border-b border-destructive/30 bg-destructive/10 p-4">
          <h2 className="font-semibold text-destructive-ink">{t('Danger Zone', 'منطقة الخطر')}</h2>
          <p className="text-sm text-destructive-ink">
            {t('Irreversible actions', 'إجراءات لا يمكن التراجع عنها')}
          </p>
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-foreground">{t('Delete Account', 'حذف الحساب')}</p>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Permanently delete your account and all associated data',
                  'امسح حسابك نهائي وكل البيانات المرتبطة بيه'
                )}
              </p>
            </div>
            <Button
              variant="destructive"
              onClick={() => {
                setForfeitAck(false);
                setShowDeleteConfirm(true);
              }}
              isLoading={isDeleting}
            >
              {t('Delete Account', 'حذف الحساب')}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Account Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl bg-card p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">
              {t('Delete Account', 'حذف الحساب')}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                'Your name, email, phone, and addresses will be permanently anonymized. Your past order records will remain (with personal data removed) for tax-compliance retention under applicable law. You will be signed out immediately. This cannot be undone.',
                'اسمك وبريدك الإلكتروني وتليفونك وعناوينك هيتخفوا نهائي. سجلات طلباتك القديمة (من غير بيانات شخصية) هتفضل موجودة عشان الالتزامات الضريبية حسب القانون. وهنخرّجك من حسابك على طول. الخطوة دي مالهاش رجوع.'
              )}
            </p>
            {walletBalance > 0 && (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-destructive/40 p-3">
                <input
                  type="checkbox"
                  checked={forfeitAck}
                  onChange={e => setForfeitAck(e.target.checked)}
                  disabled={isDeleting}
                  className="mt-0.5 h-6 w-6 shrink-0 rounded border-input accent-primary focus:ring-2 focus:ring-primary"
                />
                <span className="text-sm text-foreground">
                  {t(
                    `Your remaining wallet balance of ${money(walletBalance)} will be forfeited and cannot be refunded or recovered. I understand and accept this.`,
                    `رصيد المحفظة المتبقي ${money(walletBalance)} هيضيع ومش هيتردّ ولا هيترجّع. أنا فاهم وموافق.`
                  )}
                </span>
              </label>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                {t('Cancel', 'إلغاء')}
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteAccount}
                isLoading={isDeleting}
                disabled={walletBalance > 0 && !forfeitAck}
              >
                {t('Delete Account', 'حذف الحساب')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
