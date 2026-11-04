'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { AdminLayout } from '../../../../../components/AdminLayout';
import {
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  unwrapList,
  unwrapObject,
} from '../../../../../lib/api';
import { useT } from '@/i18n/useT';

// "أسئلة وأجوبة": the FAQ and how-to guides the storefront shows and Google/AI answers read. They moved here from the
// SEO page (UX:SEO-3): they are content the merchant writes, not search settings.

interface StoreFaq {
  id: string;
  question: string;
  questionAr: string | null;
  answer: string;
  answerAr: string | null;
  orderIndex: number;
  isActive: boolean;
}

interface HowtoStep {
  name: string;
  text: string;
  image?: string;
}

interface StoreHowto {
  id: string;
  title: string;
  titleAr: string | null;
  description: string;
  descriptionAr: string | null;
  steps: HowtoStep[];
  stepsAr: HowtoStep[] | null;
  orderIndex: number;
  isActive: boolean;
}

const EMPTY_FAQ: Omit<StoreFaq, 'id'> = {
  question: '',
  questionAr: null,
  answer: '',
  answerAr: null,
  orderIndex: 0,
  isActive: true,
};

const EMPTY_HOWTO: Omit<StoreHowto, 'id'> = {
  title: '',
  titleAr: null,
  description: '',
  descriptionAr: null,
  steps: [{ name: '', text: '' }],
  // Pre-align stepsAr with steps so the editor always has both halves
  // to render. Older rows (and rows from before bilingual editing was
  // wired) can have stepsAr = null; the load path normalizes those.
  stepsAr: [{ name: '', text: '' }],
  orderIndex: 0,
  isActive: true,
};

/**
 * Normalize a `stepsAr` array to match the length of `steps`. Older
 * HowTo rows can have `stepsAr = null` (single-language draft) or a
 * length mismatch (e.g. someone added a step in English without the
 * Arabic side existing yet). The editor renders one row per step
 * with EN and AR fields side-by-side, so the arrays MUST be the
 * same length while editing. The save path keeps `stepsAr = null`
 * possible by passing through this same shape — only the editor
 * cares about alignment.
 */
function alignStepsAr(steps: HowtoStep[], stepsAr: HowtoStep[] | null): HowtoStep[] {
  const ar = Array.isArray(stepsAr) ? stepsAr : [];
  if (ar.length === steps.length)
    return ar.map(s => ({ name: s?.name ?? '', text: s?.text ?? '' }));
  const out: HowtoStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const slot = ar[i];
    out.push({ name: slot?.name ?? '', text: slot?.text ?? '' });
  }
  return out;
}

export default function StoreFaqsPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('seo.page');
  const tPage = useT('content.faqsPage');
  const { error: toastError } = useToast();
  const [isLoading, setIsLoading] = useState(true);

  // FAQ state
  const [faqs, setFaqs] = useState<StoreFaq[]>([]);
  const [editingFaqId, setEditingFaqId] = useState<string | 'new' | null>(null);
  const [faqDraft, setFaqDraft] = useState<Omit<StoreFaq, 'id'>>(EMPTY_FAQ);
  const [isSavingFaq, setIsSavingFaq] = useState(false);

  // HowTo state
  const [howtos, setHowtos] = useState<StoreHowto[]>([]);
  const [editingHowtoId, setEditingHowtoId] = useState<string | 'new' | null>(null);
  const [howtoDraft, setHowtoDraft] = useState<Omit<StoreHowto, 'id'>>(EMPTY_HOWTO);
  const [isSavingHowto, setIsSavingHowto] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const [faqsRes, howtosRes] = await Promise.all([
        apiGet<StoreFaq[]>(`/api/v1/stores/${storeId}/faqs`),
        apiGet<StoreHowto[]>(`/api/v1/stores/${storeId}/howtos`),
      ]);
      if (faqsRes.data) setFaqs(unwrapList<StoreFaq>(faqsRes.data));
      if (howtosRes.data) setHowtos(unwrapList<StoreHowto>(howtosRes.data));
    } catch (err) {
      console.error('Failed to fetch FAQs / how-tos:', err);
    } finally {
      setIsLoading(false);
    }
  }, [storeId]);

  // --- FAQ handlers ---
  async function handleSaveFaq() {
    if (!storeId) return;
    setIsSavingFaq(true);
    try {
      if (editingFaqId === 'new') {
        const { data, error } = await apiPost<StoreFaq>(`/api/v1/stores/${storeId}/faqs`, faqDraft);
        if (error) throw new Error(error.message);
        const created = unwrapObject<StoreFaq>(data);
        if (created) setFaqs(prev => [...prev, created]);
      } else if (editingFaqId) {
        const { data, error } = await apiPut<StoreFaq>(
          `/api/v1/stores/${storeId}/faqs/${editingFaqId}`,
          faqDraft
        );
        if (error) throw new Error(error.message);
        const updated = unwrapObject<StoreFaq>(data);
        if (updated) setFaqs(prev => prev.map(f => (f.id === editingFaqId ? updated : f)));
      }
      setEditingFaqId(null);
      setFaqDraft(EMPTY_FAQ);
    } catch {
      toastError(t('faqSaveError'), '');
    } finally {
      setIsSavingFaq(false);
    }
  }

  async function handleDeleteFaq(faqId: string) {
    if (!storeId) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/faqs/${faqId}`);
      if (error) throw new Error(error.message);
      setFaqs(prev => prev.filter(f => f.id !== faqId));
    } catch {
      toastError(t('faqDeleteError'), '');
    }
  }

  async function handleToggleFaqActive(faq: StoreFaq) {
    if (!storeId) return;
    try {
      const { data, error } = await apiPut<StoreFaq>(`/api/v1/stores/${storeId}/faqs/${faq.id}`, {
        isActive: !faq.isActive,
      });
      if (error) throw new Error(error.message);
      const updated = unwrapObject<StoreFaq>(data);
      if (updated) setFaqs(prev => prev.map(f => (f.id === faq.id ? updated : f)));
    } catch {
      toastError(t('faqSaveError'), '');
    }
  }

  async function handleMoveFaq(faqId: string, direction: 'up' | 'down') {
    const idx = faqs.findIndex(f => f.id === faqId);
    if (idx === -1) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= faqs.length) return;
    const reordered = [...faqs];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    const withIndex = reordered.map((f, i) => ({ ...f, orderIndex: i }));
    setFaqs(withIndex);
    // Persist updated order indices
    await Promise.all(
      withIndex.map(f =>
        apiPut(`/api/v1/stores/${storeId}/faqs/${f.id}`, { orderIndex: f.orderIndex })
      )
    );
  }

  // --- HowTo handlers ---
  async function handleSaveHowto() {
    if (!storeId) return;
    setIsSavingHowto(true);
    try {
      if (editingHowtoId === 'new') {
        const { data, error } = await apiPost<StoreHowto>(
          `/api/v1/stores/${storeId}/howtos`,
          howtoDraft
        );
        if (error) throw new Error(error.message);
        const created = unwrapObject<StoreHowto>(data);
        if (created) setHowtos(prev => [...prev, created]);
      } else if (editingHowtoId) {
        const { data, error } = await apiPut<StoreHowto>(
          `/api/v1/stores/${storeId}/howtos/${editingHowtoId}`,
          howtoDraft
        );
        if (error) throw new Error(error.message);
        const updated = unwrapObject<StoreHowto>(data);
        if (updated) setHowtos(prev => prev.map(h => (h.id === editingHowtoId ? updated : h)));
      }
      setEditingHowtoId(null);
      setHowtoDraft(EMPTY_HOWTO);
    } catch {
      toastError(t('howtoSaveError'), '');
    } finally {
      setIsSavingHowto(false);
    }
  }

  async function handleDeleteHowto(howtoId: string) {
    if (!storeId) return;
    try {
      const { error } = await apiDelete(`/api/v1/stores/${storeId}/howtos/${howtoId}`);
      if (error) throw new Error(error.message);
      setHowtos(prev => prev.filter(h => h.id !== howtoId));
    } catch {
      toastError(t('howtoDeleteError'), '');
    }
  }

  async function handleToggleHowtoActive(howto: StoreHowto) {
    if (!storeId) return;
    try {
      const { data, error } = await apiPut<StoreHowto>(
        `/api/v1/stores/${storeId}/howtos/${howto.id}`,
        { isActive: !howto.isActive }
      );
      if (error) throw new Error(error.message);
      const updated = unwrapObject<StoreHowto>(data);
      if (updated) setHowtos(prev => prev.map(h => (h.id === howto.id ? updated : h)));
    } catch {
      toastError(t('howtoSaveError'), '');
    }
  }

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (isLoading) {
    return (
      <AdminLayout title={tPage('title')}>
        <div className="animate-pulse space-y-4">
          <div className="h-64 rounded-xl bg-muted" />
          <div className="h-64 rounded-xl bg-muted" />
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title={tPage('title')} subtitle={tPage('subtitle')}>
      <div className="space-y-6">
        {/* ===== Frequently Asked Questions ===== */}
        <div id="faqs" className="scroll-mt-24 rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 data-setting-id="seo.faqs" className="font-semibold text-foreground">
                {t('faqsTitle')}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('faqsSubtitle')}</p>
            </div>
            {editingFaqId === null && (
              <button
                type="button"
                onClick={() => {
                  setFaqDraft({ ...EMPTY_FAQ, orderIndex: faqs.length });
                  setEditingFaqId('new');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary-ink hover:bg-primary/10"
              >
                + {t('addFaq')}
              </button>
            )}
          </div>

          {/* FAQ list */}
          {faqs.map((faq, idx) => (
            <div key={faq.id} className="rounded-lg border border-border p-4 space-y-3">
              {editingFaqId === faq.id ? (
                /* Inline edit form */
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqQuestion')}
                      </label>
                      <input
                        type="text"
                        value={faqDraft.question}
                        onChange={e => setFaqDraft(d => ({ ...d, question: e.target.value }))}
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqQuestionAr')}
                      </label>
                      <input
                        type="text"
                        lang="ar"
                        dir="rtl"
                        value={faqDraft.questionAr ?? ''}
                        onChange={e =>
                          setFaqDraft(d => ({ ...d, questionAr: e.target.value || null }))
                        }
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqAnswer')}
                      </label>
                      <textarea
                        rows={3}
                        value={faqDraft.answer}
                        onChange={e => setFaqDraft(d => ({ ...d, answer: e.target.value }))}
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-foreground mb-1">
                        {t('faqAnswerAr')}
                      </label>
                      <textarea
                        rows={3}
                        lang="ar"
                        dir="rtl"
                        value={faqDraft.answerAr ?? ''}
                        onChange={e =>
                          setFaqDraft(d => ({ ...d, answerAr: e.target.value || null }))
                        }
                        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isSavingFaq}
                      onClick={handleSaveFaq}
                      className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                    >
                      {isSavingFaq ? '…' : t('faqSave')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingFaqId(null);
                        setFaqDraft(EMPTY_FAQ);
                      }}
                      className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
                    >
                      {t('faqCancel')}
                    </button>
                  </div>
                </div>
              ) : (
                /* Read view */
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground line-clamp-1">
                      {faq.question}
                    </p>
                    {faq.questionAr && (
                      <p className="text-xs text-muted-foreground line-clamp-1" dir="rtl" lang="ar">
                        {faq.questionAr}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{faq.answer}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleMoveFaq(faq.id, 'up')}
                      disabled={idx === 0}
                      title={t('faqMoveUp')}
                      className="rounded p-1 hover:bg-muted disabled:opacity-30 text-xs"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveFaq(faq.id, 'down')}
                      disabled={idx === faqs.length - 1}
                      title={t('faqMoveDown')}
                      className="rounded p-1 hover:bg-muted disabled:opacity-30 text-xs"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => handleToggleFaqActive(faq)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${faq.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
                    >
                      {faq.isActive ? t('faqActive') : t('faqInactive')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFaqDraft({
                          question: faq.question,
                          questionAr: faq.questionAr,
                          answer: faq.answer,
                          answerAr: faq.answerAr,
                          orderIndex: faq.orderIndex,
                          isActive: faq.isActive,
                        });
                        setEditingFaqId(faq.id);
                      }}
                      className="rounded p-1.5 hover:bg-muted text-xs border border-border"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteFaq(faq.id)}
                      className="rounded p-1.5 hover:bg-destructive/10 text-destructive-ink text-xs border border-border"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* New FAQ form */}
          {editingFaqId === 'new' && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqQuestion')}
                  </label>
                  <input
                    type="text"
                    value={faqDraft.question}
                    onChange={e => setFaqDraft(d => ({ ...d, question: e.target.value }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqQuestionAr')}
                  </label>
                  <input
                    type="text"
                    lang="ar"
                    dir="rtl"
                    value={faqDraft.questionAr ?? ''}
                    onChange={e => setFaqDraft(d => ({ ...d, questionAr: e.target.value || null }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqAnswer')}
                  </label>
                  <textarea
                    rows={3}
                    value={faqDraft.answer}
                    onChange={e => setFaqDraft(d => ({ ...d, answer: e.target.value }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">
                    {t('faqAnswerAr')}
                  </label>
                  <textarea
                    rows={3}
                    lang="ar"
                    dir="rtl"
                    value={faqDraft.answerAr ?? ''}
                    onChange={e => setFaqDraft(d => ({ ...d, answerAr: e.target.value || null }))}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isSavingFaq || !faqDraft.question || !faqDraft.answer}
                  onClick={handleSaveFaq}
                  className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSavingFaq ? '…' : t('faqSave')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingFaqId(null);
                    setFaqDraft(EMPTY_FAQ);
                  }}
                  className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
                >
                  {t('faqCancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ===== How-To Guides ===== */}
        <div id="howtos" className="scroll-mt-24 rounded-xl border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 data-setting-id="seo.how-tos" className="font-semibold text-foreground">
                {t('howtosTitle')}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{t('howtosSubtitle')}</p>
            </div>
            {editingHowtoId === null && (
              <button
                type="button"
                onClick={() => {
                  setHowtoDraft({ ...EMPTY_HOWTO, orderIndex: howtos.length });
                  setEditingHowtoId('new');
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary-ink hover:bg-primary/10"
              >
                + {t('addHowto')}
              </button>
            )}
          </div>

          {/* HowTo list */}
          {howtos.map(howto => (
            <div key={howto.id} className="rounded-lg border border-border p-4 space-y-3">
              {editingHowtoId === howto.id ? (
                /* Inline edit form */
                <HowtoForm
                  draft={howtoDraft}
                  setDraft={setHowtoDraft}
                  t={t}
                  isSaving={isSavingHowto}
                  onSave={handleSaveHowto}
                  onCancel={() => {
                    setEditingHowtoId(null);
                    setHowtoDraft(EMPTY_HOWTO);
                  }}
                />
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground line-clamp-1">
                      {howto.title}
                    </p>
                    {howto.titleAr && (
                      <p className="text-xs text-muted-foreground line-clamp-1" dir="rtl" lang="ar">
                        {howto.titleAr}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('stepsCount', { count: howto.steps.length })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleToggleHowtoActive(howto)}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${howto.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
                    >
                      {howto.isActive ? t('howtoActive') : t('howtoInactive')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setHowtoDraft({
                          title: howto.title,
                          titleAr: howto.titleAr,
                          description: howto.description,
                          descriptionAr: howto.descriptionAr,
                          steps: howto.steps,
                          // Align AR steps to EN steps length so the editor
                          // always has both halves to render even when the
                          // row originated from a single-language source.
                          stepsAr: alignStepsAr(howto.steps, howto.stepsAr),
                          orderIndex: howto.orderIndex,
                          isActive: howto.isActive,
                        });
                        setEditingHowtoId(howto.id);
                      }}
                      className="rounded p-1.5 hover:bg-muted text-xs border border-border"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteHowto(howto.id)}
                      className="rounded p-1.5 hover:bg-destructive/10 text-destructive-ink text-xs border border-border"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* New HowTo form */}
          {editingHowtoId === 'new' && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <HowtoForm
                draft={howtoDraft}
                setDraft={setHowtoDraft}
                t={t}
                isSaving={isSavingHowto}
                onSave={handleSaveHowto}
                onCancel={() => {
                  setEditingHowtoId(null);
                  setHowtoDraft(EMPTY_HOWTO);
                }}
                autoFocus
              />
            </div>
          )}
        </div>
      </div>
    </AdminLayout>
  );
}

// ===== HowtoForm sub-component =====

interface HowtoFormProps {
  draft: Omit<StoreHowto, 'id'>;
  setDraft: React.Dispatch<React.SetStateAction<Omit<StoreHowto, 'id'>>>;
  t: (key: string) => string;
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
}

function HowtoForm({ draft, setDraft, t, isSaving, onSave, onCancel, autoFocus }: HowtoFormProps) {
  const canSave =
    draft.title.trim() !== '' &&
    draft.description.trim() !== '' &&
    draft.steps.length > 0 &&
    draft.steps.every(s => s.name.trim() !== '' && s.text.trim() !== '');

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoGuideTitle')}
          </label>
          <input
            type="text"
            value={draft.title}
            autoFocus={autoFocus}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoGuideTitleAr')}
          </label>
          <input
            type="text"
            lang="ar"
            dir="rtl"
            value={draft.titleAr ?? ''}
            onChange={e => setDraft(d => ({ ...d, titleAr: e.target.value || null }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoDescription')}
          </label>
          <textarea
            rows={2}
            value={draft.description}
            onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">
            {t('howtoDescriptionAr')}
          </label>
          <textarea
            rows={2}
            lang="ar"
            dir="rtl"
            value={draft.descriptionAr ?? ''}
            onChange={e => setDraft(d => ({ ...d, descriptionAr: e.target.value || null }))}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>
      </div>

      {/* Steps — each step has EN + AR side-by-side. The arrays
          `steps` and `stepsAr` are kept aligned 1:1 so add/remove
          always touches both. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-foreground">{t('howtoSteps')}</label>
          <button
            type="button"
            onClick={() =>
              setDraft(d => ({
                ...d,
                steps: [...d.steps, { name: '', text: '' }],
                stepsAr: [...(d.stepsAr ?? []), { name: '', text: '' }],
              }))
            }
            className="text-xs text-primary hover:underline"
          >
            + {t('addStep')}
          </button>
        </div>
        {draft.steps.map((step, i) => {
          const stepAr = draft.stepsAr?.[i] ?? { name: '', text: '' };
          return (
            <div key={i} className="mb-2 rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary-ink">
                  {i + 1}
                </span>
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder={t('stepName')}
                    value={step.name}
                    onChange={e =>
                      setDraft(d => {
                        const steps = [...d.steps];
                        steps[i] = { ...steps[i], name: e.target.value };
                        return { ...d, steps };
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    type="text"
                    lang="ar"
                    dir="rtl"
                    placeholder={t('stepNameAr')}
                    value={stepAr.name}
                    onChange={e =>
                      setDraft(d => {
                        const stepsAr = [...(d.stepsAr ?? [])];
                        while (stepsAr.length <= i) stepsAr.push({ name: '', text: '' });
                        stepsAr[i] = { ...stepsAr[i], name: e.target.value };
                        return { ...d, stepsAr };
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                {draft.steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setDraft(d => ({
                        ...d,
                        steps: d.steps.filter((_, idx) => idx !== i),
                        stepsAr: (d.stepsAr ?? []).filter((_, idx) => idx !== i),
                      }))
                    }
                    className="text-destructive-ink hover:text-destructive-ink/80 text-xs"
                  >
                    ✕
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <textarea
                  rows={2}
                  placeholder={t('stepInstruction')}
                  value={step.text}
                  onChange={e =>
                    setDraft(d => {
                      const steps = [...d.steps];
                      steps[i] = { ...steps[i], text: e.target.value };
                      return { ...d, steps };
                    })
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
                <textarea
                  rows={2}
                  lang="ar"
                  dir="rtl"
                  placeholder={t('stepInstructionAr')}
                  value={stepAr.text}
                  onChange={e =>
                    setDraft(d => {
                      const stepsAr = [...(d.stepsAr ?? [])];
                      while (stepsAr.length <= i) stepsAr.push({ name: '', text: '' });
                      stepsAr[i] = { ...stepsAr[i], text: e.target.value };
                      return { ...d, stepsAr };
                    })
                  }
                  className="rounded-lg border border-border px-3 py-1.5 text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={isSaving || !canSave}
          onClick={onSave}
          className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
        >
          {isSaving ? '…' : t('howtoSave')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted"
        >
          {t('howtoCancel')}
        </button>
      </div>
    </div>
  );
}
