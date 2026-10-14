import type { Metadata, Viewport } from 'next';
import { Footer } from '@/components/Footer';
import { Header } from '@/components/Header';
import { RootShell } from '@/components/RootShell';
import { HOME } from '@/lib/site';

export const metadata: Metadata = {
  title: 'الصفحة مش موجودة | ابدأ استوديو للذكاء الاصطناعي',
  robots: { index: false, follow: true },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#0A0B0C', colorScheme: 'dark' };

/** 404 for every path (static export writes it to out/404.html), Arabic first with English. */
export default function NotFound() {
  return (
    <RootShell locale="ar">
      <Header locale="ar" offHome />
      <main id="main" className="wrap not-found">
        <p className="nf-code" aria-hidden="true">
          404
        </p>
        <h1>الصفحة دي مش موجودة.</h1>
        <p className="lead" lang="en" dir="ltr">
          This page doesn’t exist.
        </p>
        <p className="actions">
          <a href={HOME.ar} className="btn btn-primary btn-lg">
            الرئيسية
          </a>
          <a href={HOME.en} className="btn btn-ghost btn-lg" lang="en">
            English home
          </a>
        </p>
      </main>
      <Footer locale="ar" />
    </RootShell>
  );
}
