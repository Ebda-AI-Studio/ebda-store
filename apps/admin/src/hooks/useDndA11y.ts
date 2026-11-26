'use client';

import { useMemo } from 'react';
import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core';
import { useT } from '@/i18n/useT';

interface SortableData {
  sortable?: { index?: number };
}

/** 1-based position of a sortable target, or null when dnd-kit gave no index. */
function positionOf(over: { data: { current?: unknown } } | null): number | null {
  const index = (over?.data.current as SortableData | undefined)?.sortable?.index;
  return typeof index === 'number' ? index + 1 : null;
}

/**
 * Translated screen-reader copy for every dnd-kit context in the admin. dnd-kit ships English
 * defaults, which a screen reader reads out in the Arabic editor. Spread into `<DndContext {...a11y}>`.
 * The announcements name a position, never an id (ids are uuids, meaningless when spoken).
 */
export function useDndA11y(): {
  accessibility: {
    screenReaderInstructions: ScreenReaderInstructions;
    announcements: Announcements;
  };
} {
  const t = useT('common.dndA11y');
  return useMemo(
    () => ({
      accessibility: {
        screenReaderInstructions: { draggable: t('instructions') },
        announcements: {
          onDragStart: () => t('pickedUp'),
          onDragOver: ({ over }) => {
            const position = positionOf(over);
            return position === null ? undefined : t('movedOver', { position });
          },
          onDragMove: () => undefined,
          onDragEnd: ({ over }) => {
            const position = positionOf(over);
            return position === null ? t('droppedBack') : t('dropped', { position });
          },
          onDragCancel: () => t('cancelled'),
        },
      },
    }),
    [t]
  );
}
