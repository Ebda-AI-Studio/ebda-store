import { forwardRef, InputHTMLAttributes, useId } from 'react';
import { cn } from '../utils/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, label, error, id, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id || generatedId;
    const errorId = `${inputId}-error`;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <input
          type={type}
          id={inputId}
          data-error={error ? 'true' : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            // h-11 (44px) is the minimum recommended tap target on mobile;
            // sm:h-10 keeps the denser appearance on desktop where pointer
            // accuracy isn't constrained.
            'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-all duration-200 sm:h-10',
            'file:border-0 file:bg-transparent file:text-sm file:font-medium',
            'placeholder:text-muted-foreground',
            'hover:bg-muted/30',
            'focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:ring-offset-2 focus-visible:border-primary',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'data-[error=true]:border-destructive data-[error=true]:focus:ring-destructive/20 data-[error=true]:focus-visible:ring-destructive/20',
            error &&
              'border-destructive focus:ring-destructive/20 focus-visible:ring-destructive/20',
            className
          )}
          ref={ref}
          {...props}
        />
        {error && (
          <p id={errorId} className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export { Input };
