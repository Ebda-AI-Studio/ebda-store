import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { Providers } from './providers';
import '../styles/globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
});

const ibmPlexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  variable: '--font-arabic',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: {
    default: 'Force Admin | Platform Management',
    template: '%s | Force Admin',
  },
  description: 'Force Website Builder - Enterprise E-commerce Platform Administration',
  keywords: ['admin', 'dashboard', 'e-commerce', 'Force Media', 'Kuwait'],
  authors: [{ name: 'Force Media' }],
  creator: 'Force Media Kuwait',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Inline script to prevent flash of wrong theme on page load.
            Only reads from localStorage — no user input, safe static content. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=localStorage.getItem('admin-theme');var p=window.matchMedia('(prefers-color-scheme:dark)').matches;if(s==='dark'||(!s&&p)){document.documentElement.classList.add('dark')}}catch(e){}`,
          }}
        />
      </head>
      <body className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
