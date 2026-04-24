'use client';

import { useT } from '@/i18n/useT';
import type { Step } from './types';

interface StepIndicatorProps {
  currentStep: Step;
  onJumpTo: (step: Step) => void;
}

interface StepMeta {
  id: Step;
  nameKey: 'stepStoreName' | 'stepOwnerName' | 'stepReviewName';
}

const STEPS: StepMeta[] = [
  { id: 'store', nameKey: 'stepStoreName' },
  { id: 'owner', nameKey: 'stepOwnerName' },
  { id: 'review', nameKey: 'stepReviewName' },
];

export function StepIndicator({ currentStep, onJumpTo }: StepIndicatorProps) {
  const t = useT('stores.new');
  const currentIndex = STEPS.findIndex(s => s.id === currentStep);

  return (
    <nav className="mb-8">
      <ol className="flex items-center">
        {STEPS.map((step, index) => (
          <li
            key={step.id}
            className={`flex items-center ${index < STEPS.length - 1 ? 'flex-1' : ''}`}
          >
            <button
              type="button"
              onClick={() => index < currentIndex && onJumpTo(step.id)}
              disabled={index > currentIndex}
              className={`flex items-center ${index <= currentIndex ? 'cursor-pointer' : 'cursor-not-allowed'}`}
            >
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-full border-2 text-sm font-medium ${
                  index < currentIndex
                    ? 'border-primary bg-primary text-white'
                    : index === currentIndex
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                }`}
              >
                {index < currentIndex ? (
                  <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={`ms-3 text-sm font-medium hidden sm:block ${
                  index <= currentIndex ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {t(step.nameKey)}
              </span>
            </button>
            {index < STEPS.length - 1 && (
              <div
                className={`ms-4 flex-1 border-t-2 ${
                  index < currentIndex ? 'border-primary' : 'border-border'
                }`}
              />
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
