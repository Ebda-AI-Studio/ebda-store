'use client';

import { sizeChartName, type PublicSizeChart } from '@ebda/shared';
import { ShopChrome } from '../../components';
import { useLanguage } from '../../contexts/LanguageContext';
import { SizeChartTable } from '../../components/commerce/SizeChartDialog';

export default function SizeGuideClient({ charts }: { charts: PublicSizeChart[] }) {
  const { language, t } = useLanguage();
  const lang = language === 'ar' ? 'ar' : 'en';
  return (
    <ShopChrome>
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold text-foreground">
          {t('Size guide', 'دليل المقاسات')}
        </h1>
        <div className="mt-6 divide-y divide-border border-t border-border">
          {charts.map(chart => (
            <section key={chart.id} aria-labelledby={`size-chart-${chart.id}`} className="py-6">
              <h2
                id={`size-chart-${chart.id}`}
                className="mb-3 text-base font-semibold text-foreground"
              >
                {sizeChartName(chart, lang)}
              </h2>
              <SizeChartTable chart={chart} />
            </section>
          ))}
        </div>
      </div>
    </ShopChrome>
  );
}
