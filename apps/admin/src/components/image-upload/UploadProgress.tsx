'use client';

interface UploadProgressProps {
  progress: number;
  label: string;
  /** Tailwind width utility for the progress bar track (e.g. 'w-32' / 'w-40'). */
  trackWidthClass?: string;
}

/**
 * Spinner + progress bar shown inside an upload dropzone while a file is
 * being uploaded. Stateless — callers supply the progress value and label.
 */
export function UploadProgress({ progress, label, trackWidthClass = 'w-32' }: UploadProgressProps) {
  return (
    <div className="space-y-2">
      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className={`mx-auto ${trackWidthClass} h-1.5 bg-muted rounded-full overflow-hidden`}>
        <div
          className="h-full bg-primary rounded-full transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
