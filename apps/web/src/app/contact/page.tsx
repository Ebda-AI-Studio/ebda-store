import type { Metadata } from 'next';
import ContactClient from './ContactClient';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with us. We are happy to help with any questions or feedback.',
};

export default function ContactPage() {
  return <ContactClient />;
}
