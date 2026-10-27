import type { Metadata } from 'next';
import { WhatsAppPage } from '@/components/WhatsAppPage';
import { pageMetadata } from '@/lib/seo';
import { WHATSAPP_PAGE } from '@/lib/whatsapp-page';

const p = WHATSAPP_PAGE['en'];

export const metadata: Metadata = pageMetadata(
  'en',
  'whatsapp',
  p.meta.title,
  p.meta.desc,
  'whatsapp'
);

export default function Page() {
  return <WhatsAppPage locale="en" />;
}
