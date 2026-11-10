'use client';

import { useState } from 'react';
import { Button, Input } from '@ebda/ui';
import { ImageUpload } from '../../../components/ImageUpload';
import { adminUiLocale, apiPost } from '../../../lib/api';
import { egpToPiastres } from '../../../lib/onboarding-validation';
import { useT } from '@/i18n/useT';

export function ProductStep({
  storeId,
  addedCount: initialCount,
  onBack,
  onAdded,
  onDone,
}: {
  storeId: string;
  addedCount: number;
  onBack: () => void;
  /** A product was saved; the new total. */
  onAdded: (total: number) => void;
  /** Continue to the next step. */
  onDone: () => void;
}) {
  const t = useT('onboarding.flow.product');
  const tFlow = useT('onboarding.flow');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('10');
  const [photo, setPhoto] = useState('');
  const [errors, setErrors] = useState<{ name?: string; price?: string; stock?: string }>({});
  const [formError, setFormError] = useState('');
  const [adding, setAdding] = useState(false);
  const [addedCount, setAddedCount] = useState(initialCount);
  const [justAdded, setJustAdded] = useState('');

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    const piastres = egpToPiastres(price);
    const next = {
      name: name.trim() ? undefined : t('nameRequired'),
      price: piastres ? undefined : t('priceInvalid'),
      stock: /^\d{1,6}$/.test(stock.trim()) ? undefined : t('stockInvalid'),
    };
    setErrors(next);
    if (next.name || next.price || next.stock || !piastres) return;

    setAdding(true);
    const { error } = await apiPost(`/api/v1/stores/${storeId}/products`, {
      // One field, typed in the admin's language: say which, so an Arabic name is stored as the Arabic name and the AI
      // fills the English one (never the reverse; 2026-11-10 swapped pair, Ruling NAME-PAIR-1).
      name: name.trim(),
      sourceLang: adminUiLocale(),
      price: piastres,
      // New products from onboarding go live with the store.
      status: 'active',
      inventory: Number(stock.trim()),
      ...(photo ? { images: [{ url: photo }] } : {}),
    });
    setAdding(false);
    if (error) {
      setFormError(error.code === 'PLAN_LIMIT_REACHED' ? t('limit') : t('addFailed'));
      return;
    }
    setJustAdded(name.trim());
    setName('');
    setPrice('');
    setPhoto('');
    setAddedCount(addedCount + 1);
    onAdded(addedCount + 1);
  }

  return (
    <form onSubmit={handleAdd} className="space-y-4" noValidate>
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {formError && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {formError}
        </div>
      )}
      {justAdded && (
        <p role="status" className="rounded-lg bg-success/10 p-3 text-sm text-success-ink">
          {t('added', { name: justAdded })}
        </p>
      )}
      <Input
        id="product-name"
        label={t('name')}
        value={name}
        onChange={e => {
          setName(e.target.value);
          setErrors(prev => ({ ...prev, name: undefined }));
        }}
        placeholder={t('namePlaceholder')}
        error={errors.name}
      />
      <Input
        id="product-price"
        label={t('price')}
        dir="ltr"
        inputMode="decimal"
        value={price}
        onChange={e => {
          setPrice(e.target.value);
          setErrors(prev => ({ ...prev, price: undefined }));
        }}
        placeholder={t('pricePlaceholder')}
        error={errors.price}
      />
      <Input
        id="product-stock"
        label={t('stock')}
        dir="ltr"
        inputMode="numeric"
        value={stock}
        onChange={e => {
          setStock(e.target.value);
          setErrors(prev => ({ ...prev, stock: undefined }));
        }}
        error={errors.stock}
      />
      <ImageUpload
        label={t('photo')}
        value={photo}
        onUpload={setPhoto}
        onRemove={() => setPhoto('')}
        folder="products"
        storeId={storeId}
        aspectRatio="1/1"
      />
      <Button type="submit" variant="outline" className="w-full" disabled={adding}>
        {adding ? t('adding') : t('add')}
      </Button>
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button type="button" className="flex-1" onClick={onDone}>
          {addedCount > 0 ? tFlow('next') : tFlow('skip')}
        </Button>
      </div>
    </form>
  );
}
