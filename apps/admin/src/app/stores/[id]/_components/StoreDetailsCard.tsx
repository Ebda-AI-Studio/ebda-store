'use client';

import { Badge, Input, Label } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { formatDate } from '../../../../lib/format';
import { getStoreDisplayUrl } from '../../../../lib/store-url';
import { useT } from '@/i18n/useT';
import { statusColors, type Store, type StoreEditForm, type StoreFormErrors } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

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
  /** Opens the edit form on the status field: an inactive store gets a visible way to go live (audit D-1). */
  onActivate?: () => void;
  /** Start editing; the page header no longer carries "edit store" (its primary is the editor). */
  onEdit?: () => void;
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
  onActivate,
  onEdit,
}: StoreDetailsCardProps) {
  const t = useT('stores.dashboard.details');
  const statusLabel = {
    active: t('statusActive'),
    inactive: t('statusInactive'),
    suspended: t('statusSuspended'),
  }[store.status];
  // Plan UI removed 2026-05-22 (Ahmad): no public tier list, agency model.
  // Store.plan enum stays in DB as internal tracking but doesn't appear in
  // any merchant-visible or super-admin UI.

  return (
    <div className="lg:col-span-2 rounded-md border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b p-4">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
        {!isEditing && onEdit && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            {t('edit')}
          </Button>
        )}
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
                <p className="mt-1 text-sm text-destructive-ink">{formErrors.name}</p>
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
                <p className="mt-1 text-sm text-destructive-ink">{formErrors.slug}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {t('slugHint', {
                  slug: editForm.slug || t('slugHintPlaceholder'),
                })}
              </p>
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
                className={`${FIELD_CLASSES} mt-1`}
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
              <p className="font-medium text-foreground">{getStoreDisplayUrl(store)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t('status')}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={statusColors[store.status]}>{statusLabel}</Badge>
                {store.status === 'inactive' && onActivate && (
                  <Button type="button" size="sm" variant="outline" onClick={onActivate}>
                    {t('activateCta')}
                  </Button>
                )}
              </div>
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
