'use client';

import { Alert } from '../../../../../components/Alert';
import type { StatusMessage } from './types';

interface PwaStatusMessageProps {
  message: StatusMessage;
}

/**
 * Inline success/error banner rendered above the save action. Backed by the
 * shared Alert component so colors and spacing stay consistent with the other
 * admin status banners.
 */
export function PwaStatusMessage({ message }: PwaStatusMessageProps) {
  return (
    <Alert
      variant={message.type === 'success' ? 'success' : 'destructive'}
      description={message.text}
    />
  );
}
