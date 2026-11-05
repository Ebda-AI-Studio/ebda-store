'use client';

import { useEffect } from 'react';
import { resumeGrantedAlerts } from '../lib/push-opt-in';

/** Renders nothing. When the browser already granted notifications, starts the push SDK silently so tapping an alert opens its order. */
export function PushClickListener() {
  useEffect(() => {
    void resumeGrantedAlerts();
  }, []);
  return null;
}
