'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';
import { AdminLayout } from '../../../../../components/AdminLayout';
import { Toggle } from '../../../../../components/Toggle';
import { ImageUpload } from '../../../../../components/ImageUpload';
import { apiGet, apiPut } from '../../../../../lib/api';

interface StorePageData {
  id?: string;
  storeId?: string;
  slug: string;
  title?: string | null;
  titleAr?: string | null;
  contentMd?: string | null;
  contentMdAr?: string | null;
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

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function buildPreview(md: string): string {
  if (!md.trim()) return '';
  const esc = (s: string) => s.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] || ch);
  const inline = (line: string) => {
    let out = esc(line);
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, url: string) =>
        `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return out;
  };
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^-\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^-\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^-\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map(it => `<li>${inline(it)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map(it => `<li>${inline(it)}</li>`).join('')}</ol>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const ln = lines[i].trim();
      if (!ln) break;
      if (/^(#{1,3})\s+/.test(ln) || /^-\s+/.test(ln) || /^\d+\.\s+/.test(ln)) break;
      para.push(ln);
      i++;
    }
    out.push(`<p>${para.map(inline).join('<br />')}</p>`);
  }
  return out.join('\n');
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
    contentMd: '',
    contentMdAr: '',
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
      }));
    } else if (payload?.page) {
      setData({
        ...payload.page,
        title: payload.page.title ?? '',
        titleAr: payload.page.titleAr ?? '',
        contentMd: payload.page.contentMd ?? '',
        contentMdAr: payload.page.contentMdAr ?? '',
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
      contentMd: data.contentMd,
      contentMdAr: data.contentMdAr,
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

  const previewEn = useMemo(() => buildPreview(data.contentMd ?? ''), [data.contentMd]);
  const previewAr = useMemo(() => buildPreview(data.contentMdAr ?? ''), [data.contentMdAr]);

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
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || isLoading}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors cursor-pointer"
          >
            {isSaving ? t('saving') : t('save')}
          </button>
        </div>
      }
    >
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {isLoading ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            …
          </div>
        ) : (
          <>
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
                />
              </div>
            </SectionCard>

            <SectionCard title={t('sectionContent')}>
              <p className="mb-3 text-xs text-muted-foreground">{t('markdownTip')}</p>
              <div className="grid gap-6 lg:grid-cols-2">
                <FieldArea
                  label={t('fieldContent')}
                  value={data.contentMd ?? ''}
                  placeholder={t('fieldContentPlaceholder')}
                  onChange={v => setData(d => ({ ...d, contentMd: v }))}
                  preview={previewEn}
                  previewLabel={t('previewHeading')}
                  previewEmpty={t('previewEmpty')}
                />
                <FieldArea
                  label={t('fieldContentAr')}
                  value={data.contentMdAr ?? ''}
                  placeholder={t('fieldContentArPlaceholder')}
                  onChange={v => setData(d => ({ ...d, contentMdAr: v }))}
                  preview={previewAr}
                  previewLabel={t('previewHeading')}
                  previewEmpty={t('previewEmpty')}
                  dir="rtl"
                />
              </div>
            </SectionCard>

            <SectionCard title={t('sectionMeta')}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t('fieldPublished')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t('publishedHint')}</p>
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
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </label>
  );
}

function FieldArea({
  label,
  value,
  placeholder,
  onChange,
  preview,
  previewLabel,
  previewEmpty,
  dir,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  preview: string;
  previewLabel: string;
  previewEmpty: string;
  dir?: 'ltr' | 'rtl';
}) {
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-foreground">{label}</span>
        <textarea
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          dir={dir}
          rows={16}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </label>
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
