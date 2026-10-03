import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { RootShell } from '@/components/RootShell';
import { pageMetadata } from '@/lib/seo';

export const metadata: Metadata = pageMetadata('en', '');
export const viewport: Viewport = { themeColor: '#0A0B0C', colorScheme: 'dark' };

export default function Layout({ children }: { children: ReactNode }) {
  return <RootShell locale="en">{children}</RootShell>;
}
