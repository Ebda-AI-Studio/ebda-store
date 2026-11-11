'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

interface FormFooterProps {
  /** Outcome verb for the primary action: "ضيف المنتج", not "تأكيد". */
  primaryLabel: string;
  /** Where "إلغاء" goes. */
  cancelHref: string;
  /** Submit the surrounding <form>. Omit `onPrimary` and the button is `type=submit`. */
  onPrimary?: () => void;
  saving?: boolean;
  disabled?: boolean;
}

/**
 * Create flows (rule 4): a sticky footer with the primary at the inline-end edge and "إلغاء" as a text button at the
 * inline-start edge. One form = one job; never in a sidebar column, never in the header.
 */
export function FormFooter({
  primaryLabel,
  cancelHref,
  onPrimary,
  saving = false,
  disabled = false,
}: FormFooterProps) {
  const t = useT('components.formFooter');
  return (
    <div className="sticky bottom-[calc(var(--bottom-chrome))] z-20 -mx-4 mt-8 border-t border-border bg-card/95 px-4 py-3 backdrop-blur-md lg:-mx-6 lg:px-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href={cancelHref}
          className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {t('cancel')}
        </Link>
        <Button
          type={onPrimary ? 'button' : 'submit'}
          onClick={onPrimary}
          disabled={disabled || saving}
          isLoading={saving}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
