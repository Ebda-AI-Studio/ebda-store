'use client';

/**
 * ProductFaqSection — inline FAQ editor for the product edit page.
 *
 * Features:
 *  - Lists saved FAQ rows with inline edit/delete
 *  - "Add FAQ" inline form (EN + AR question + answer)
 *  - "Generate with AI" calls the per-product draft endpoint, returns
 *    AI proposals that the merchant can accept (Save) or discard one-by-one
 *
 * Mount below the SEO section in the product edit page.
 */

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Button, Input, Textarea, useToast } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api';

interface ProductFaq {
  id: string;
  question: string;
  questionAr: string | null;
  answer: string;
  answerAr: string | null;
  aiDrafted: boolean;
  manuallyEdited: boolean;
  createdAt: string;
}

interface AiDraftFaq {
  question: string;
  questionAr?: string;
  answer: string;
  answerAr?: string;
  isDraft: true;
}

interface EditState {
  question: string;
  questionAr: string;
  answer: string;
  answerAr: string;
}

const EMPTY_EDIT: EditState = { question: '', questionAr: '', answer: '', answerAr: '' };

interface Props {
  storeId: string;
  productId: string;
}

/** Imperative handle so the product edit page's single "Generate with AI"
 * button can trigger a FAQ draft alongside SEO + AEO, reusing this
 * section's own draft endpoint call + review-before-save UX rather than
 * duplicating the save/draft logic on the parent page. */
export interface ProductFaqSectionHandle {
  /** Fetches AI-drafted FAQs into the review list (same as clicking the
   * section's own "Generate with AI" button). Returns true on success so
   * the caller can report partial failure without throwing. */
  generateWithAi: () => Promise<boolean>;
}

const UNDO_WINDOW_MS = 6000;

export const ProductFaqSection = forwardRef<ProductFaqSectionHandle, Props>(
  function ProductFaqSection({ storeId, productId }, ref) {
    const t = useT('products.edit.faqs');
    const tBadge = useT('products.aiFieldBadge');
    const tCommon = useT('common');
    const { success: toastSuccess, error: toastError, addToast } = useToast();
    // Delete = undo window, not a native confirm (rule 7: reversible actions offer undo).
    const pendingDeletes = useRef(
      new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }>()
    );

    const [faqs, setFaqs] = useState<ProductFaq[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);

    // Key = faq id for saved rows. 'new' for the add-new inline form.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editState, setEditState] = useState<EditState>(EMPTY_EDIT);
    const [saving, setSaving] = useState(false);

    // AI draft rows — shown above the add-new button, not yet persisted.
    const [aiDrafts, setAiDrafts] = useState<AiDraftFaq[]>([]);
    const [aiGenerating, setAiGenerating] = useState(false);
    const [savingDraftIndex, setSavingDraftIndex] = useState<number | null>(null);

    const [open, setOpen] = useState(true);

    const fetchFaqs = useCallback(async () => {
      try {
        setLoadError(false);
        const { data, error } = await apiGet<ProductFaq[]>(
          `/api/v1/stores/${storeId}/products/${productId}/faqs`
        );
        if (error) {
          setLoadError(true);
          return;
        }
        setFaqs(data ?? []);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }, [storeId, productId]);

    useEffect(() => {
      fetchFaqs();
    }, [fetchFaqs]);

    // ── Add / Edit saved row ──────────────────────────────────────────────

    function startEdit(faq: ProductFaq) {
      setEditingId(faq.id);
      setEditState({
        question: faq.question,
        questionAr: faq.questionAr ?? '',
        answer: faq.answer,
        answerAr: faq.answerAr ?? '',
      });
    }

    function startNew() {
      setEditingId('new');
      setEditState(EMPTY_EDIT);
    }

    function cancelEdit() {
      setEditingId(null);
      setEditState(EMPTY_EDIT);
    }

    async function saveEdit() {
      if (!editState.question.trim() || !editState.answer.trim()) return;
      setSaving(true);
      try {
        if (editingId === 'new') {
          const { data, error } = await apiPost<ProductFaq>(
            `/api/v1/stores/${storeId}/products/${productId}/faqs`,
            editState
          );
          if (error || !data) {
            toastError(t('saveError'), '');
            return;
          }
          setFaqs(prev => [...prev, data]);
        } else {
          const { data, error } = await apiPut<ProductFaq>(
            `/api/v1/stores/${storeId}/products/${productId}/faqs/${editingId}`,
            editState
          );
          if (error || !data) {
            toastError(t('saveError'), '');
            return;
          }
          setFaqs(prev => prev.map(f => (f.id === editingId ? data : f)));
        }
        cancelEdit();
      } catch {
        toastError(t('saveError'), '');
      } finally {
        setSaving(false);
      }
    }

    // ── Delete ────────────────────────────────────────────────────────────

    async function commitDelete(id: string) {
      const { error } = await apiDelete(
        `/api/v1/stores/${storeId}/products/${productId}/faqs/${id}`
      );
      if (error) toastError(t('deleteError'), '');
    }

    function deleteFaq(id: string) {
      const index = faqs.findIndex(f => f.id === id);
      const removed = faqs[index];
      if (!removed || pendingDeletes.current.has(id)) return;
      setFaqs(prev => prev.filter(f => f.id !== id));
      const run = async () => {
        pendingDeletes.current.delete(id);
        await commitDelete(id);
      };
      const timer = setTimeout(() => void run(), UNDO_WINDOW_MS);
      pendingDeletes.current.set(id, { timer, run });
      addToast({
        type: 'info',
        title: t('deletedToast'),
        duration: UNDO_WINDOW_MS,
        action: {
          label: t('undo'),
          onClick: () => {
            const pending = pendingDeletes.current.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingDeletes.current.delete(id);
            setFaqs(prev => {
              const next = [...prev];
              next.splice(Math.min(index, next.length), 0, removed);
              return next;
            });
          },
        },
      });
    }

    // Leaving the page inside the undo window must not silently keep a row the merchant deleted.
    useEffect(() => {
      const pending = pendingDeletes.current;
      return () => {
        pending.forEach(p => {
          clearTimeout(p.timer);
          void p.run();
        });
      };
    }, []);

    // ── AI generation ─────────────────────────────────────────────────────

    const generateWithAi = useCallback(async (): Promise<boolean> => {
      setAiGenerating(true);
      try {
        const { data, error } = await apiPost<{
          faqs: Array<{
            question: string;
            questionAr?: string;
            answer: string;
            answerAr?: string;
          }>;
        }>(`/api/v1/stores/${storeId}/ai/product-faqs/draft`, { productId, count: 5 });
        if (error || !data?.faqs?.length) {
          toastError(t('aiError'), '');
          return false;
        }
        const drafts: AiDraftFaq[] = data.faqs.map(f => ({ ...f, isDraft: true as const }));
        setAiDrafts(drafts);
        toastSuccess(t('aiSuccess', { count: String(drafts.length) }), '');
        return true;
      } catch {
        toastError(t('aiError'), '');
        return false;
      } finally {
        setAiGenerating(false);
      }
    }, [storeId, productId, t, toastError, toastSuccess]);

    useImperativeHandle(ref, () => ({ generateWithAi }), [generateWithAi]);

    async function saveAiDraft(index: number) {
      const draft = aiDrafts[index];
      if (!draft) return;
      setSavingDraftIndex(index);
      try {
        const { data, error } = await apiPost<ProductFaq>(
          `/api/v1/stores/${storeId}/products/${productId}/faqs`,
          {
            question: draft.question,
            questionAr: draft.questionAr ?? null,
            answer: draft.answer,
            answerAr: draft.answerAr ?? null,
          }
        );
        if (error || !data) {
          toastError(t('saveError'), '');
          return;
        }
        setFaqs(prev => [...prev, data]);
        setAiDrafts(prev => prev.filter((_, i) => i !== index));
      } catch {
        toastError(t('saveError'), '');
      } finally {
        setSavingDraftIndex(null);
      }
    }

    function discardAiDraft(index: number) {
      setAiDrafts(prev => prev.filter((_, i) => i !== index));
    }

    function discardAllAiDrafts() {
      setAiDrafts([]);
    }

    async function saveAllAiDrafts() {
      // Save sequentially; array shrinks after each save so always target index 0.
      const count = aiDrafts.length;
      for (let i = 0; i < count; i++) {
        await saveAiDraft(0);
      }
    }

    // ── Render ────────────────────────────────────────────────────────────

    if (loading) {
      return (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        </div>
      );
    }

    return (
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        {/* Section header with collapse toggle */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-2 text-lg font-semibold text-foreground hover:text-primary transition-colors"
            aria-expanded={open}
          >
            <svg
              className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            {t('title')}
            {faqs.length > 0 && (
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink">
                {faqs.length}
              </span>
            )}
          </button>

          {open && (
            <button
              type="button"
              onClick={generateWithAi}
              disabled={aiGenerating}
              className="inline-flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span aria-hidden="true">✨</span>
              {aiGenerating ? t('generating') : t('generateWithAi')}
            </button>
          )}
        </div>

        {open && (
          <>
            <p className="mb-4 text-xs text-muted-foreground">{t('description')}</p>

            {loadError && <p className="mb-4 text-sm text-destructive-ink">{t('loadError')}</p>}

            {/* AI draft rows */}
            {aiDrafts.length > 0 && (
              <div className="mb-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-primary-ink">{t('reviewNote')}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveAllAiDrafts}
                      className="text-xs text-primary hover:underline"
                    >
                      {t('saveAll')}
                    </button>
                    <button
                      type="button"
                      onClick={discardAllAiDrafts}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      {t('discardAll')}
                    </button>
                  </div>
                </div>
                {aiDrafts.map((draft, idx) => (
                  <div key={idx} className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                    <div className="mb-2 grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('question')}
                        </p>
                        <p className="text-sm text-foreground">{draft.question}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('questionAr')}
                        </p>
                        <p className="text-sm text-foreground" dir="rtl">
                          {draft.questionAr ?? '—'}
                        </p>
                      </div>
                    </div>
                    <div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('answer')}
                        </p>
                        <p className="text-sm text-muted-foreground">{draft.answer}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('answerAr')}
                        </p>
                        <p className="text-sm text-muted-foreground" dir="rtl">
                          {draft.answerAr ?? '—'}
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => saveAiDraft(idx)}
                        disabled={savingDraftIndex === idx}
                      >
                        {savingDraftIndex === idx ? '…' : t('saveRow')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => discardAiDraft(idx)}
                      >
                        {t('cancelRow')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Saved FAQ rows */}
            {faqs.length === 0 && aiDrafts.length === 0 && (
              <p className="mb-4 text-sm text-muted-foreground">{t('empty')}</p>
            )}

            {faqs.map(faq => (
              <div key={faq.id} className="mb-3">
                {editingId === faq.id ? (
                  <FaqEditForm
                    state={editState}
                    onChange={setEditState}
                    onSave={saveEdit}
                    onCancel={cancelEdit}
                    saving={saving}
                    t={t}
                  />
                ) : (
                  <div className="rounded-lg border bg-background p-4">
                    <div className="mb-2 grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('question')}
                        </p>
                        <p className="text-sm font-medium text-foreground">{faq.question}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('questionAr')}
                        </p>
                        <p className="text-sm font-medium text-foreground" dir="rtl">
                          {faq.questionAr ?? '—'}
                        </p>
                      </div>
                    </div>
                    <div className="mb-3 grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('answer')}
                        </p>
                        <p className="text-sm text-muted-foreground">{faq.answer}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-xs font-medium text-muted-foreground">
                          {t('answerAr')}
                        </p>
                        <p className="text-sm text-muted-foreground" dir="rtl">
                          {faq.answerAr ?? '—'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      {faq.aiDrafted && !faq.manuallyEdited && (
                        <span className="text-xs text-muted-foreground">{tBadge('aiLabel')}</span>
                      )}
                      <div className="ml-auto flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(faq)}
                        >
                          {tCommon('edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => deleteFaq(faq.id)}
                        >
                          {tCommon('delete')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add new inline form */}
            {editingId === 'new' ? (
              <FaqEditForm
                state={editState}
                onChange={setEditState}
                onSave={saveEdit}
                onCancel={cancelEdit}
                saving={saving}
                t={t}
              />
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={startNew} className="mt-2">
                + {t('addFaq')}
              </Button>
            )}
          </>
        )}
      </div>
    );
  }
);

// ── Shared inline edit form ─────────────────────────────────────────────

interface FaqEditFormProps {
  state: EditState;
  onChange: (s: EditState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  t: (key: string, params?: Record<string, string>) => string;
}

function FaqEditForm({ state, onChange, onSave, onCancel, saving, t }: FaqEditFormProps) {
  const tl = useT('products.edit');
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Input
          label={t('question')}
          value={state.question}
          onChange={e => onChange({ ...state, question: e.target.value })}
          placeholder={tl('faqQuestionEnSample')}
          required
        />
        <Input
          label={t('questionAr')}
          value={state.questionAr}
          onChange={e => onChange({ ...state, questionAr: e.target.value })}
          placeholder={tl('faqQuestionArSample')}
          lang="ar"
          dir="rtl"
        />
      </div>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Textarea
          label={t('answer')}
          value={state.answer}
          onChange={e => onChange({ ...state, answer: e.target.value })}
          placeholder={tl('faqAnswerEnSample')}
          rows={3}
          required
        />
        <Textarea
          label={t('answerAr')}
          value={state.answerAr}
          onChange={e => onChange({ ...state, answerAr: e.target.value })}
          placeholder={tl('faqAnswerArSample')}
          rows={3}
          lang="ar"
          dir="rtl"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          onClick={onSave}
          disabled={saving || !state.question.trim() || !state.answer.trim()}
        >
          {saving ? '…' : t('saveRow')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t('cancelRow')}
        </Button>
      </div>
    </div>
  );
}
