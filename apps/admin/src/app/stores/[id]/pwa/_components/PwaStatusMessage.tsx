'use client';

import type { StatusMessage } from './types';

interface PwaStatusMessageProps {
  message: StatusMessage;
}

/**
 * Inline success/error banner rendered above the save action.
 */
export function PwaStatusMessage({ message }: PwaStatusMessageProps) {
  return (
    <div
      className={`rounded-xl p-4 text-sm ${
        message.type === 'success'
          ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
          : 'bg-destructive/5 border border-destructive/30 text-destructive'
      }`}
    >
      {message.text}
    </div>
  );
}
