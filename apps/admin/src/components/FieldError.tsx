/** Inline error under a form field (from `fieldErrorsFrom(apiError.details)`); renders nothing when there is none. */
export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-sm text-destructive-ink" role="alert">
      {message}
    </p>
  );
}
