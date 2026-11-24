import Link from 'next/link';
import { useT } from '@/i18n/useT';

interface SettingsLinkProps {
  storeId: string;
}

export function SettingsLink({ storeId }: SettingsLinkProps) {
  const t = useT('stores.dashboard.settings');
  return (
    <div className="mt-8">
      <Link
        href={`/stores/${storeId}/settings`}
        className="flex items-center justify-between rounded-md border bg-card p-5 shadow-sm transition hover:border-primary hover:shadow-md group"
      >
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted transition-transform group-hover:scale-110">
            <svg
              className="h-6 w-6 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-foreground group-hover:text-primary transition-colors">
              {t('title')}
            </p>
            <p className="text-sm text-muted-foreground">{t('description')}</p>
          </div>
        </div>
        <svg
          className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </Link>
    </div>
  );
}
