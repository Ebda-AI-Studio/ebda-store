import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import type { Store } from './types';

interface StoreOwnerCardProps {
  /** Absent when the API sent a store without its owner: the card is then omitted, never a crash. */
  owner?: Store['owner'] | null;
}

export function StoreOwnerCard({ owner }: StoreOwnerCardProps) {
  const t = useT('stores.dashboard.owner');
  if (!owner) return null;
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="border-b p-4">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
      </div>
      <div className="p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary-ink">
            <span className="text-lg font-bold">
              {owner.firstName?.[0]}
              {owner.lastName?.[0]}
            </span>
          </div>
          <div>
            <p className="font-medium text-foreground">
              {owner.firstName} {owner.lastName}
            </p>
            <p className="text-sm text-muted-foreground">{owner.email}</p>
          </div>
        </div>
        <div className="mt-6 space-y-2">
          <Link href={`/users/${owner.id}`}>
            <Button variant="outline" size="sm" className="w-full">
              {t('viewProfile')}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
