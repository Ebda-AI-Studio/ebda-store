'use client';

/**
 * What the right pane teaches while nothing is selected (editor premium F57): one plain sentence
 * (click anything on the page to edit it) and up to three of the most common next steps. An action
 * only shows when its handler is wired, so the card never offers something that does nothing.
 */
import { LayoutTemplate, MousePointerClick, Palette, Plus, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';

export interface EmptyActions {
  onAddSection?: () => void;
  onOpenTheme?: () => void;
  onOpenTemplates?: () => void;
}

export function SettingsEmptyState({ actions }: { actions?: EmptyActions }) {
  const t = useT('builder.settings');
  const items: Array<{ key: string; icon: LucideIcon; label: string; run: () => void }> = [];
  if (actions?.onAddSection)
    items.push({ key: 'add', icon: Plus, label: t('emptyAdd'), run: actions.onAddSection });
  if (actions?.onOpenTheme)
    items.push({ key: 'theme', icon: Palette, label: t('emptyTheme'), run: actions.onOpenTheme });
  if (actions?.onOpenTemplates)
    items.push({
      key: 'template',
      icon: LayoutTemplate,
      label: t('emptyTemplate'),
      run: actions.onOpenTemplates,
    });
  return (
    <div
      className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-center"
      data-testid="settings-empty-state"
    >
      <MousePointerClick
        className="mx-auto h-6 w-6 text-primary-ink"
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <p className="mt-2 text-sm font-semibold">{t('emptyTitle')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('emptyHint')}</p>
      {items.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {items.map(({ key, icon: Icon, label, run }) => (
            <li key={key}>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={run}
                className="w-full justify-start gap-2"
                data-testid={`empty-action-${key}`}
              >
                <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                {label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
