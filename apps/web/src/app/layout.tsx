import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ToastProvider } from '@force/ui';
import '../styles/globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: {
    default: 'Force Store',
    template: '%s | Force Store',
  },
  description: 'Modern e-commerce powered by Force Media',
  keywords: ['e-commerce', 'online store', 'shopping'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ToastProvider>
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
