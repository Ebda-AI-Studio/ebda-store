'use client';

import type { ReactNode } from 'react';
import { Button, buttonVariants, cn } from '@ebda/ui';
import Link from 'next/link';
import { RowActions, type RowActionItem } from './RowActions';

export interface PageHeaderAction {
  label: string;
  /** Navigates when set; otherwise `onClick` runs. */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  isLoading?: boolean;
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** The page's ONE main job, a verb: "منتج جديد", "احفظ". Rendered filled, at the inline-end edge. */
  primary?: PageHeaderAction;
  /** At most one outline companion ("شوف المتجر"). */
  secondary?: PageHeaderAction;
  /** Everything else (export, import, print, reorder, AI helpers) lives in the "..." menu. */
  overflow?: RowActionItem[];
  /** Optional trailing slot for non-button status (a badge). Never a second Button. */
  status?: ReactNode;
}

function ActionButton({
  action,
  variant,
}: {
  action: PageHeaderAction;
  variant: 'default' | 'outline';
}) {
  if (action.href && !action.disabled) {
    return (
      <Link href={action.href} className={cn(buttonVariants({ variant }), 'min-h-11')}>
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      variant={variant}
      className="min-h-11"
      onClick={action.onClick}
      disabled={action.disabled}
      isLoading={action.isLoading}
    >
      {action.label}
    </Button>
  );
}

/**
 * The page header of the action-placement standard (rule 1-3): title block at the inline-start edge, then at most
 * 1 primary + 1 secondary + a "..." overflow. No "back to settings / store" here: navigation back is the hub tab
 * strip or the breadcrumb. See docs/admin/ACTION-PLACEMENT-STANDARD.md.
 */
export function PageHeader({
  title,
  subtitle,
  primary,
  secondary,
  overflow,
  status,
}: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status}
        {overflow && overflow.length > 0 && <RowActions items={overflow} />}
        {secondary && <ActionButton action={secondary} variant="outline" />}
        {primary && <ActionButton action={primary} variant="default" />}
      </div>
    </div>
  );
}
