import type { ReactNode } from 'react';
import '@/app/route-devices.css';

/** Phone frame drawn in CSS (bezel, glass, reflections); the screen shows a capture of a template look. */
export function Phone({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`dev-phone ${className}`.trim()}>
      <div className="dev-screen">
        <span className="dev-island" />
        {children}
      </div>
    </div>
  );
}
