'use client';

/**
 * "View in your space" on a desktop: a QR of the product page for the shopper's phone. The QR
 * library is imported on first open, so it is never part of the viewer's own chunk.
 */
import { useEffect, useState } from 'react';

export interface ArDesktopQrLabels {
  open: string;
  title: string;
  hint: string;
  close: string;
}

/** A non-modal popover (role=group, Escape closes), not a dialog: the page stays usable (R-04). */
export function ArDesktopQr({ url, labels }: { url: string; labels: ArDesktopQrLabels }) {
  const [open, setOpen] = useState(false);
  const [img, setImg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || img) return;
    let cancelled = false;
    void import('qrcode').then(async mod => {
      const data = await mod.default.toDataURL(url, { margin: 1, width: 192 });
      if (!cancelled) setImg(data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, img, url]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="absolute bottom-3 end-3 inline-flex h-10 items-center gap-1.5 rounded-full bg-foreground px-4 text-sm font-medium text-background shadow-md"
      >
        {labels.open}
      </button>
      {open && (
        <div
          role="group"
          onKeyDown={e => e.key === 'Escape' && setOpen(false)}
          aria-label={labels.title}
          className="absolute bottom-16 end-3 z-10 w-56 rounded-xl border border-input bg-background p-3 text-center shadow-lg"
        >
          <p className="text-sm font-semibold text-foreground">{labels.title}</p>
          <div className="mx-auto mt-2 flex h-48 w-48 items-center justify-center rounded-md bg-white">
            {img ? <img src={img} alt="" width={192} height={192} className="h-48 w-48" /> : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{labels.hint}</p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 inline-flex h-9 items-center rounded-full border border-input px-3 text-xs font-medium text-foreground"
          >
            {labels.close}
          </button>
        </div>
      )}
    </>
  );
}
