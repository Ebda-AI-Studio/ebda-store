import type { Metadata } from 'next';
import AboutClient from './AboutClient';

export const metadata: Metadata = {
  title: 'About Us',
  description: 'Learn more about our store',
};

export default function AboutPage() {
  return <AboutClient />;
}
