'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';

/** A labelled value with a copy button (InstaPay handle / amount / reference). */
export function CopyRow({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (insecure context); the value is visible to copy by hand.
    }
  }
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p dir="ltr" className="break-all text-start font-medium text-foreground">
          {value}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`${copyLabel} ${label}`}
        onClick={copy}
      >
        {copied ? copiedLabel : copyLabel}
      </Button>
    </div>
  );
}
