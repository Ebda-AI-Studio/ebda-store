'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AdminLayout } from '../../../../components/AdminLayout';
import { apiGet, apiPut } from '../../../../lib/api';
import { useToast } from '@force/ui';
import { useT } from '@/i18n/useT';

type TemplateId = 'modern' | 'classic' | 'minimal' | 'bold' | 'elegant';

interface Template {
  id: TemplateId;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  tags: string[];
  bestFor: string;
  previewColor: string;
}

const templates: Template[] = [
  {
    id: 'modern',
    name: 'Modern',
    nameAr: 'عصري',
    description:
      'Clean lines, bold accents, and contemporary feel. Perfect for tech and lifestyle brands.',
    descriptionAr: 'خطوط نظيفة ولمسات جريئة وشعور معاصر. مثالي لماركات التكنولوجيا ونمط الحياة.',
    tags: ['Tech', 'Lifestyle', 'Gadgets'],
    bestFor: 'Tech, lifestyle, and modern brands',
    previewColor: 'from-primary to-primary/90',
  },
  {
    id: 'classic',
    name: 'Classic',
    nameAr: 'كلاسيكي',
    description:
      'Elegant serif fonts and timeless sophistication. Ideal for luxury and heritage brands.',
    descriptionAr: 'خطوط أنيقة وتطور خالد. مثالي للعلامات الفاخرة والتراثية.',
    tags: ['Luxury', 'Heritage', 'Traditional'],
    bestFor: 'Luxury, heritage, and established brands',
    previewColor: 'from-amber-700 to-amber-800',
  },
  {
    id: 'minimal',
    name: 'Minimal',
    nameAr: 'بسيط',
    description:
      'Maximum whitespace, product-focused design. Great for photography and art galleries.',
    descriptionAr: 'مساحة بيضاء واسعة وتصميم يركز على المنتج. رائع للتصوير ومعارض الفن.',
    tags: ['Photography', 'Art', 'Design'],
    bestFor: 'Photography, art galleries, and design studios',
    previewColor: 'from-neutral-800 to-neutral-900',
  },
  {
    id: 'bold',
    name: 'Bold',
    nameAr: 'جريء',
    description:
      'Vibrant colors, dynamic layouts, energetic feel. Perfect for youth and sports brands.',
    descriptionAr:
      'ألوان نابضة وتخطيطات ديناميكية وشعور بالطاقة. مثالي للعلامات الشبابية والرياضية.',
    tags: ['Youth', 'Sports', 'Streetwear'],
    bestFor: 'Youth brands, sports, and streetwear',
    previewColor: 'from-purple-500 to-purple-600',
  },
  {
    id: 'elegant',
    name: 'Elegant',
    nameAr: 'أنيق',
    description:
      'Fashion-forward design with refined aesthetics. Best for fashion and beauty brands.',
    descriptionAr: 'تصميم عصري بجماليات راقية. الأفضل لماركات الأزياء والجمال.',
    tags: ['Fashion', 'Jewelry', 'Beauty'],
    bestFor: 'Fashion, jewelry, and beauty brands',
    previewColor: 'from-rose-500 to-rose-600',
  },
];

export default function StoreTemplatePage() {
  const params = useParams();
  const router = useRouter();
  const storeId = params?.id as string;
  const t = useT('template.page');
  const toast = useToast();

  const [store, setStore] = useState<{ name: string; template: TemplateId } | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('modern');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Inlined the sibling fetchStore into the effect so the dependency list
  // stays honest (only storeId). Cancellation flag prevents setState after
  // unmount if the user navigates away mid-request.
  useEffect(() => {
    let cancelled = false;
    async function fetchStore() {
      try {
        const { data } = await apiGet<{ store: { name: string; template?: TemplateId } }>(
          `/api/v1/stores/${storeId}`
        );
        if (cancelled) return;
        if (data?.store) {
          setStore({
            name: data.store.name,
            template: data.store.template || 'modern',
          });
          setSelectedTemplate(data.store.template || 'modern');
        }
      } catch (error) {
        console.error('Failed to fetch store:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    fetchStore();
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  async function handleSave() {
    setIsSaving(true);
    try {
      const { error } = await apiPut(`/api/v1/stores/${storeId}/template`, {
        template: selectedTemplate,
      });

      if (error) {
        toast.error(t('saveError'), error.message || t('saveErrorBody'));
        return;
      }

      toast.success(t('saveSuccess'), t('saveSuccessBody'));
      router.push(`/stores/${storeId}`);
    } catch (err) {
      console.error('Failed to update template:', err);
      toast.error(t('saveError'), t('saveErrorBody'));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('storeNotFound')}</p>
        <Link href="/stores" className="text-primary hover:underline mt-2 inline-block">
          {t('backToStores')}
        </Link>
      </div>
    );
  }

  return (
    <AdminLayout
      title={t('title')}
      subtitle={t('subtitleWithStore', { storeName: store.name })}
      actions={
        <div className="flex items-center gap-3">
          <Link
            href={`/stores/${storeId}`}
            className="px-4 py-2 border border-border rounded-lg hover:bg-muted"
          >
            {t('cancel')}
          </Link>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || selectedTemplate === store.template}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {isSaving ? t('saving') : t('apply')}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Templates Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.map(template => {
            const isSelected = selectedTemplate === template.id;
            const isCurrent = store.template === template.id;

            return (
              <button
                type="button"
                key={template.id}
                onClick={() => setSelectedTemplate(template.id)}
                className={`relative text-start bg-card rounded-2xl border-2 overflow-hidden transition-all hover:shadow-lg ${
                  isSelected
                    ? 'border-primary ring-4 ring-primary/20'
                    : 'border-border hover:border-border'
                }`}
              >
                {/* Preview */}
                <div
                  className={`h-48 bg-gradient-to-br ${template.previewColor} p-6 flex flex-col justify-between`}
                >
                  <div className="flex items-start justify-between">
                    <div className="text-white">
                      <h3 className="text-2xl font-bold">{template.name}</h3>
                      <p className="text-white/70 text-sm mt-1">{template.nameAr}</p>
                    </div>
                    {isCurrent && (
                      <span className="bg-white/20 text-white text-xs px-2 py-1 rounded-full">
                        {t('current')}
                      </span>
                    )}
                  </div>

                  {/* Mock Preview Elements */}
                  <div className="flex gap-2">
                    <div className="w-12 h-12 bg-white/20 rounded-lg"></div>
                    <div className="w-12 h-12 bg-white/20 rounded-lg"></div>
                    <div className="w-12 h-12 bg-white/20 rounded-lg"></div>
                  </div>
                </div>

                {/* Info */}
                <div className="p-4">
                  <p className="text-muted-foreground text-sm mb-3">{template.description}</p>

                  <div className="flex flex-wrap gap-2 mb-3">
                    {template.tags.map(tag => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-1 bg-muted text-muted-foreground rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground">{template.bestFor}</p>
                </div>

                {/* Selection Indicator */}
                {isSelected && (
                  <div className="absolute top-4 end-4 w-6 h-6 bg-white rounded-full flex items-center justify-center shadow">
                    <svg
                      className="w-4 h-4 text-primary"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Help Text */}
        <div className="bg-info/5 border border-info/30 rounded-xl p-4">
          <div className="flex gap-3">
            <svg
              className="w-5 h-5 text-info shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <p className="text-info font-medium">{t('aboutTitle')}</p>
              <p className="text-info text-sm mt-1">
                {t('aboutBody')}
                <Link href={`/stores/${storeId}/branding`} className="underline ms-1">
                  {t('brandingSettings')}
                </Link>
                .
              </p>
            </div>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
