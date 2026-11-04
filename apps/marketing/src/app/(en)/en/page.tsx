import { StudioHomePage } from '@/components/StudioHome';
import { pageMetadata } from '@/lib/seo';
import { STUDIO_HOME } from '@/lib/studio-home';

const c = STUDIO_HOME['en'];

export const metadata = pageMetadata('en', '', c.meta.title, c.meta.desc, 'studio');

export default function Page() {
  return <StudioHomePage locale="en" />;
}
