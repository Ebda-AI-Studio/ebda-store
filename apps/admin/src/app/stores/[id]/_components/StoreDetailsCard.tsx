'use client';

import { Badge, Button, Input, Label } from '@force/ui';
import { formatDate } from '../../../../lib/format';
import { useT } from '@/i18n/useT';
import { statusColors, type Store, type StoreEditForm, type StoreFormErrors } from './types';

interface StoreDetailsCardProps {
  store: Store;
  isEditing: boolean;
  isSaving: boolean;
  editForm: StoreEditForm;
  formErrors: StoreFormErrors;
  onChangeForm: React.Dispatch<React.SetStateAction<StoreEditForm>>;
  onClearFieldError: (field: keyof StoreFormErrors) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function StoreDetailsCard({
  store,
  isEditing,
  isSaving,
  editForm,
  formErrors,
  onChangeForm,
  onClearFieldError,
  onSave,
  onCancel,
}: StoreDetailsCardProps) {
  const t = useT('stores.dashboard.details');
  const statusLabel = {
    active: t('statusActive'),
    inactive: t('statusInactive'),
    suspended: t('statusSuspended'),
  }[store.status];
  const planLabel = {
    free: t('planFree'),
    starter: t('planStarter'),
    professional: t('planProfessional'),
    enterprise: t('planEnterprise'),
  }[store.plan];

  return (
    <div className="lg:col-span-2 rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
        {isEditing && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={onSave} disabled={isSaving}>
              {isSaving ? t('saving') : t('save')}
            </Button>
          </div>
        )}
      </div>
      <div className="p-6 space-y-4">
        {isEditing ? (
          <>
            <div>
              <Label htmlFor="name">{t('storeName')}</Label>
              <Input
                id="name"
                value={editForm.name}
                onChange={e => {
                  const value = e.target.value;
                  onChangeForm(prev => ({ ...prev, name: value }));
                  if (formErrors.name) onClearFieldError('name');
                }}
                className={`mt-1 ${
                  formErrors.name
                    ? 'border-destructive focus:border-destructive focus:ring-destructive'
                    : ''
                }`}
              />
              {formErrors.name && (
                <p className="mt-1 text-sm text-destructive">{formErrors.name}</p>
              )}
            </div>
            <div>
              <Label htmlFor="slug">{t('urlSlug')}</Label>
              <Input
                id="slug"
                value={editForm.slug}
                onChange={e => {
                  const value = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                  onChangeForm(prev => ({ ...prev, slug: value }));
                  if (formErrors.slug) onClearFieldError('slug');
                }}
                className={`mt-1 ${
                  formErrors.slug
                    ? 'border-destructive focus:border-destructive focus:ring-destructive'
                    : ''
                }`}
                placeholder={t('slugPlaceholder')}
              />
              {formErrors.slug && (
                <p className="mt-1 text-sm text-destructive">{formErrors.slug}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {t('slugHint', {
                  slug: editForm.slug || t('slugHintPlaceholder'),
                })}
              </p>
            </div>
            <div>
              <Label htmlFor="plan">{t('plan')}</Label>
              <select
                id="plan"
                value={editForm.plan}
                onChange={e => {
                  const value = e.target.value;
                  onChangeForm(prev => ({ ...prev, plan: value }));
                }}
                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="free">{t('planFree')}</option>
                <option value="starter">{t('planStarter')}</option>
                <option value="professional">{t('planProfessional')}</option>
                <option value="enterprise">{t('planEnterprise')}</option>
              </select>
            </div>
            <div>
              <Label htmlFor="status">{t('status')}</Label>
              <select
                id="status"
                value={editForm.status}
                onChange={e => {
                  const value = e.target.value;
                  onChangeForm(prev => ({ ...prev, status: value }));
                }}
                className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="active">{t('statusActive')}</option>
                <option value="inactive">{t('statusInactive')}</option>
                <option value="suspended">{t('statusSuspended')}</option>
              </select>
            </div>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">{t('storeName')}</p>
              <p className="font-medium text-foreground">{store.name}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('url')}</p>
              <p className="font-medium text-foreground">
                {store.domain || `${store.slug}.forcemediakw.com`}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('status')}</p>
              <Badge variant={statusColors[store.status]} className="mt-1">
                {statusLabel}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('plan')}</p>
              <p className="font-medium text-foreground">{planLabel}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('created')}</p>
              <p className="font-medium text-foreground">{formatDate(store.createdAt)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('lastUpdated')}</p>
              <p className="font-medium text-foreground">{formatDate(store.updatedAt)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
