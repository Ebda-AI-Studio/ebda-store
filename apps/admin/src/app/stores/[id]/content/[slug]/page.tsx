'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useToast } from '@ebda/ui';
import { recommendedSizeText } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { Toggle } from '../../../../../components/Toggle';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { apiGet, apiPut } from '../../../../../lib/api';

// ---------- Block schema (mirrors apps/api/src/services/pages.service.ts) ----------

type Block =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'image'; url: string; alt: string }
  | { type: 'button'; label: string; url: string };

type BlockType = Block['type'];

const BLOCK_TYPES: BlockType[] = ['heading', 'paragraph', 'bullets', 'numbered', 'image', 'button'];

function makeBlock(type: BlockType): Block {
  switch (type) {
    case 'heading':
      return { type: 'heading', level: 2, text: '' };
    case 'paragraph':
      return { type: 'paragraph', text: '' };
    case 'bullets':
      return { type: 'bullets', items: [''] };
    case 'numbered':
      return { type: 'numbered', items: [''] };
    case 'image':
      return { type: 'image', url: '', alt: '' };
    case 'button':
      return { type: 'button', label: '', url: '' };
  }
}

// ---------- Renderer (mirrors apps/api/src/services/pages.service.ts) ----------
//
// Replicated client-side so the editor can show a live preview without
// a round-trip. The API runs the same logic on save and is the source
// of truth for what the storefront actually renders.

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] || ch);
}

function safeUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return '#';
  if (/^(\/|#|\?|\.\/|\.\.\/)/.test(trimmed)) return escapeHtml(trimmed);
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return escapeHtml(trimmed);
  return '#';
}

function renderBlocksToHtml(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': {
        const level = b.level === 3 ? 3 : 2;
        const text = escapeHtml(b.text || '');
        if (text) out.push(`<h${level}>${text}</h${level}>`);
        break;
      }
      case 'paragraph': {
        if (!b.text || !b.text.trim()) break;
        const lines = b.text.replace(/\r\n/g, '\n').split('\n').map(escapeHtml);
        out.push(`<p>${lines.join('<br />')}</p>`);
        break;
      }
      case 'bullets':
      case 'numbered': {
        const tag = b.type === 'bullets' ? 'ul' : 'ol';
        const li = (b.items || [])
          .filter(it => typeof it === 'string' && it.trim().length > 0)
          .map(it => `<li>${escapeHtml(it)}</li>`)
          .join('');
        if (li) out.push(`<${tag}>${li}</${tag}>`);
        break;
      }
      case 'image': {
        if (!b.url || !b.url.trim()) break;
        out.push(
          `<figure class="cms-image"><img src="${safeUrl(b.url)}" alt="${escapeHtml(b.alt || '')}" loading="lazy" /></figure>`
        );
        break;
      }
      case 'button': {
        if (!b.url || !b.url.trim() || !b.label || !b.label.trim()) break;
        const isExternal = /^https?:/i.test(b.url.trim());
        const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
        out.push(
          `<p class="cms-button-row"><a class="cms-button" href="${safeUrl(b.url)}"${target}>${escapeHtml(b.label)}</a></p>`
        );
        break;
      }
    }
  }
  return out.join('\n');
}

interface StorePageData {
  id?: string;
  storeId?: string;
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  contentBlocks?: Block[] | null;
  contentBlocksAr?: Block[] | null;
  coverImage?: string | null;
  isPublished: boolean;
}

const BUILT_IN_TITLES: Record<string, { en: string; ar: string }> = {
  about: { en: 'About Us', ar: 'من نحن' },
  privacy: { en: 'Privacy Policy', ar: 'سياسة الخصوصية' },
  terms: { en: 'Terms of Service', ar: 'الشروط والأحكام' },
  shipping: { en: 'Shipping Policy', ar: 'سياسة الشحن' },
  faq: { en: 'FAQ', ar: 'الأسئلة الشائعة' },
};

function normalizeBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) return [];
  const out: Block[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Partial<Block> & { type?: string };
    switch (b.type) {
      case 'heading':
        out.push({
          type: 'heading',
          level: b.level === 3 ? 3 : 2,
          text: typeof b.text === 'string' ? b.text : '',
        });
        break;
      case 'paragraph':
        out.push({ type: 'paragraph', text: typeof b.text === 'string' ? b.text : '' });
        break;
      case 'bullets':
        out.push({
          type: 'bullets',
          items: Array.isArray(b.items)
            ? b.items.filter((x): x is string => typeof x === 'string')
            : [],
        });
        break;
      case 'numbered':
        out.push({
          type: 'numbered',
          items: Array.isArray(b.items)
            ? b.items.filter((x): x is string => typeof x === 'string')
            : [],
        });
        break;
      case 'image':
        out.push({
          type: 'image',
          url: typeof b.url === 'string' ? b.url : '',
          alt: typeof b.alt === 'string' ? b.alt : '',
        });
        break;
      case 'button':
        out.push({
          type: 'button',
          label: typeof b.label === 'string' ? b.label : '',
          url: typeof b.url === 'string' ? b.url : '',
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export default function ContentEditorPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const slug = decodeURIComponent((params?.slug as string) || '');
  const t = useT('content.editor');
  const { success: toastSuccess, error: toastError } = useToast();

  const [data, setData] = useState<StorePageData>({
    slug,
    title: '',
    titleAr: '',
    contentBlocks: [],
    contentBlocksAr: [],
    coverImage: '',
    isPublished: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const fetchPage = useCallback(async () => {
    if (!storeId || !slug) return;
    setIsLoading(true);
    const { data: payload, error } = await apiGet<{ page: StorePageData }>(
      `/api/v1/stores/${storeId}/pages/${encodeURIComponent(slug)}`
    );
    if (error) {
      const builtIn = BUILT_IN_TITLES[slug];
      setData(prev => ({
        ...prev,
        title: builtIn?.en ?? '',
        titleAr: builtIn?.ar ?? '',
        contentBlocks: [],
        contentBlocksAr: [],
      }));
    } else if (payload?.page) {
      setData({
        ...payload.page,
        title: payload.page.title ?? '',
        titleAr: payload.page.titleAr ?? '',
        contentBlocks: normalizeBlocks(payload.page.contentBlocks),
        contentBlocksAr: normalizeBlocks(payload.page.contentBlocksAr),
        coverImage: payload.page.coverImage ?? '',
      });
    }
    setIsLoading(false);
  }, [storeId, slug]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  const handleSave = async () => {
    if (!storeId || !slug) return;
    setIsSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}/pages/${encodeURIComponent(slug)}`, {
      title: data.title,
      titleAr: data.titleAr,
      contentBlocks: data.contentBlocks ?? [],
      contentBlocksAr: data.contentBlocksAr ?? [],
      coverImage: data.coverImage,
      isPublished: data.isPublished,
    });
    setIsSaving(false);
    if (error) {
      toastError(t('saveError'));
    } else {
      toastSuccess(t('saved'));
    }
  };

  const previewEn = useMemo(
    () => renderBlocksToHtml(data.contentBlocks ?? []),
    [data.contentBlocks]
  );
  const previewAr = useMemo(
    () => renderBlocksToHtml(data.contentBlocksAr ?? []),
    [data.contentBlocksAr]
  );

  const heading = BUILT_IN_TITLES[slug]?.en ?? data.title?.trim() ?? slug;

  return (
    <AdminLayout
      mode="store_admin"
      storeId={storeId}
      title={`${t('title')} — ${heading}`}
      subtitle={slug}
      actions={
        <div className="flex items-center gap-2">
          <Link
            href={`/stores/${storeId}/content`}
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('backToList')}
          </Link>
          <Button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isLoading}
            className="gap-2 font-semibold"
          >
            {isSaving ? t('saving') : t('save')}
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
        {isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : (
          <>
            {/* Deep-link callout for the two slugs whose customer-facing
                content actually lives in a different surface: the FAQ
                accordion items live in `store_faqs` (managed at /seo)
                and How-To Guides live in `store_howtos` (also /seo).
                This page only edits the static block wrapper around
                them; without the callout merchants run the AI bulk
                sweep, come here looking for the generated content,
                and see an empty editor. Fixes the recurring
                "where did the data go?" confusion. */}
            {(slug === 'faq' || slug === 'how-to-guides') && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm text-foreground">
                <p className="font-medium">{slug === 'faq' ? t('aiFaqNote') : t('aiHowToNote')}</p>
                <p className="mt-1 text-muted-foreground">{t('wrapperNote')}</p>
                <Link
                  href={`/stores/${storeId}/seo#${slug === 'faq' ? 'faqs' : 'howtos'}`}
                  className="mt-2 inline-flex items-center text-sm font-medium text-primary hover:underline"
                >
                  {slug === 'faq' ? t('openFaqInSeo') : t('openHowToInSeo')}
                </Link>
              </div>
            )}

            <SectionCard title={t('sectionDetails')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldText
                  label={t('fieldTitle')}
                  value={data.title ?? ''}
                  placeholder={t('fieldTitlePlaceholder')}
                  onChange={v => setData(d => ({ ...d, title: v }))}
                />
                <FieldText
                  label={t('fieldTitleAr')}
                  value={data.titleAr ?? ''}
                  placeholder={t('fieldTitleArPlaceholder')}
                  onChange={v => setData(d => ({ ...d, titleAr: v }))}
                  dir="rtl"
                />
              </div>
              <div className="mt-4">
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('fieldCover')}
                </label>
                <ImageUpload
                  value={data.coverImage ?? ''}
                  onUpload={url => setData(d => ({ ...d, coverImage: url }))}
                  onRemove={() => setData(d => ({ ...d, coverImage: '' }))}
                  folder="pages"
                  storeId={storeId}
                  recommendedSizeHint={recommendedSizeText('pageCover')}
                />
              </div>
            </SectionCard>

            <SectionCard title={t('sectionContent')}>
              <p className="mb-3 text-xs text-muted-foreground">{t('blocksTip')}</p>
              <div className="grid gap-6 lg:grid-cols-2">
                <BlockColumn
                  label={t('fieldContent')}
                  blocks={data.contentBlocks ?? []}
                  onChange={next => setData(d => ({ ...d, contentBlocks: next }))}
                  preview={previewEn}
                  previewLabel={t('previewHeading')}
                  previewEmpty={t('previewEmpty')}
                  storeId={storeId}
                  t={t}
                />
                <BlockColumn
                  label={t('fieldContentAr')}
                  blocks={data.contentBlocksAr ?? []}
                  onChange={next => setData(d => ({ ...d, contentBlocksAr: next }))}
                  preview={previewAr}
                  previewLabel={t('previewHeading')}
                  previewEmpty={t('previewEmpty')}
                  storeId={storeId}
                  t={t}
                  dir="rtl"
                />
              </div>
            </SectionCard>

            <SectionCard title={t('sectionMeta')}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {t('fieldShowOnStorefront')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('showOnStorefrontHint')}</p>
                </div>
                <Toggle
                  checked={data.isPublished}
                  onChange={v => setData(d => ({ ...d, isPublished: v }))}
                />
              </div>
            </SectionCard>
          </>
        )}
      </div>
    </AdminLayout>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function FieldText({
  label,
  value,
  placeholder,
  onChange,
  dir,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        dir={dir}
        className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

// ---------- Block editor column ----------

function BlockColumn({
  label,
  blocks,
  onChange,
  preview,
  previewLabel,
  previewEmpty,
  storeId,
  t,
  dir,
}: {
  label: string;
  blocks: Block[];
  onChange: (next: Block[]) => void;
  preview: string;
  previewLabel: string;
  previewEmpty: string;
  storeId: string;
  t: (key: string) => string;
  dir?: 'ltr' | 'rtl';
}) {
  const [pendingType, setPendingType] = useState<BlockType>('paragraph');

  const updateAt = (idx: number, next: Block) => {
    const copy = blocks.slice();
    copy[idx] = next;
    onChange(copy);
  };

  const removeAt = (idx: number) => {
    onChange(blocks.filter((_, i) => i !== idx));
  };

  const moveAt = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= blocks.length) return;
    const copy = blocks.slice();
    [copy[idx], copy[target]] = [copy[target], copy[idx]];
    onChange(copy);
  };

  const addBlock = () => {
    onChange([...blocks, makeBlock(pendingType)]);
  };

  return (
    <div className="space-y-3">
      <div className="block">
        <span className="mb-1.5 block text-sm font-medium text-foreground">{label}</span>
        <div className="space-y-3 rounded-lg border border-border bg-background p-3">
          {blocks.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('noBlocksYet')}</p>
          )}
          {blocks.map((block, idx) => (
            <BlockEditor
              key={idx}
              block={block}
              index={idx}
              total={blocks.length}
              onChange={next => updateAt(idx, next)}
              onRemove={() => removeAt(idx)}
              onMoveUp={() => moveAt(idx, -1)}
              onMoveDown={() => moveAt(idx, 1)}
              storeId={storeId}
              t={t}
              dir={dir}
            />
          ))}
          <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-border pt-3">
            <select
              value={pendingType}
              onChange={e => setPendingType(e.target.value as BlockType)}
              className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {BLOCK_TYPES.map(bt => (
                <option key={bt} value={bt}>
                  {t(`blockType.${bt}`)}
                </option>
              ))}
            </select>
            <Button size="sm" type="button" onClick={addBlock} className="gap-1 font-semibold">
              {/* sign-ok: button label glyph, not a number */}+ {t('addBlock')}
            </Button>
          </div>
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs font-medium text-muted-foreground">{previewLabel}</span>
        <div
          className="cms-markdown prose prose-sm max-w-none rounded-lg border border-dashed border-border bg-muted/20 p-3 text-sm text-foreground"
          dir={dir}
        >
          {preview ? (
            <div dangerouslySetInnerHTML={{ __html: preview }} />
          ) : (
            <span className="text-muted-foreground">{previewEmpty}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function BlockEditor({
  block,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  storeId,
  t,
  dir,
}: {
  block: Block;
  index: number;
  total: number;
  onChange: (next: Block) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  storeId: string;
  t: (key: string) => string;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {t(`blockType.${block.type}`)}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            title={t('moveUp')}
            aria-label={t('moveUp')}
          >
            ↑
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1}
            title={t('moveDown')}
            aria-label={t('moveDown')}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={onRemove}
            title={t('removeBlock')}
            aria-label={t('removeBlock')}
            className="text-destructive-ink"
          >
            ✕
          </Button>
        </div>
      </div>
      <BlockFields block={block} onChange={onChange} storeId={storeId} t={t} dir={dir} />
    </div>
  );
}

function BlockFields({
  block,
  onChange,
  storeId,
  t,
  dir,
}: {
  block: Block;
  onChange: (next: Block) => void;
  storeId: string;
  t: (key: string) => string;
  dir?: 'ltr' | 'rtl';
}) {
  switch (block.type) {
    case 'heading':
      return (
        <div className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('headingLevel')}
            </span>
            <select
              value={block.level}
              onChange={e => onChange({ ...block, level: Number(e.target.value) === 3 ? 3 : 2 })}
              className="rounded-lg border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {/* i18n-gate-allow: heading level token */}
              <option value={2}>H2</option>
              {/* i18n-gate-allow: heading level token */}
              <option value={3}>H3</option>
            </select>
          </label>
          <input
            type="text"
            value={block.text}
            onChange={e => onChange({ ...block, text: e.target.value })}
            placeholder={t('headingTextPlaceholder')}
            dir={dir}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      );
    case 'paragraph':
      return (
        <textarea
          value={block.text}
          onChange={e => onChange({ ...block, text: e.target.value })}
          placeholder={t('paragraphPlaceholder')}
          rows={5}
          dir={dir}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      );
    case 'bullets':
    case 'numbered':
      return (
        <ItemListEditor
          items={block.items}
          onChange={items => onChange({ ...block, items })}
          t={t}
          dir={dir}
        />
      );
    case 'image':
      return (
        <div className="space-y-2">
          <ImageUpload
            value={block.url}
            onUpload={url => onChange({ ...block, url })}
            onRemove={() => onChange({ ...block, url: '' })}
            folder="pages"
            storeId={storeId}
          />
          <input
            type="text"
            value={block.alt}
            onChange={e => onChange({ ...block, alt: e.target.value })}
            placeholder={t('imageAltPlaceholder')}
            dir={dir}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      );
    case 'button':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={block.label}
            onChange={e => onChange({ ...block, label: e.target.value })}
            placeholder={t('buttonLabelPlaceholder')}
            dir={dir}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="text"
            value={block.url}
            onChange={e => onChange({ ...block, url: e.target.value })}
            placeholder={t('buttonUrlPlaceholder')}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      );
  }
}

function ItemListEditor({
  items,
  onChange,
  t,
  dir,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  t: (key: string) => string;
  dir?: 'ltr' | 'rtl';
}) {
  const updateAt = (idx: number, value: string) => {
    const copy = items.slice();
    copy[idx] = value;
    onChange(copy);
  };
  const removeAt = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };
  const addItem = () => {
    onChange([...items, '']);
  };
  return (
    <div className="space-y-2">
      <span className="block text-xs font-medium text-muted-foreground">{t('items')}</span>
      {items.length === 0 && <p className="text-xs text-muted-foreground">{t('noItemsYet')}</p>}
      {items.map((it, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="text"
            value={it}
            onChange={e => updateAt(idx, e.target.value)}
            dir={dir}
            className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={() => removeAt(idx)}
            title={t('removeItem')}
            aria-label={t('removeItem')}
            className="text-destructive-ink"
          >
            ✕
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" type="button" onClick={addItem} className="gap-1">
        {/* sign-ok: button label glyph, not a number */}+ {t('addItem')}
      </Button>
    </div>
  );
}
