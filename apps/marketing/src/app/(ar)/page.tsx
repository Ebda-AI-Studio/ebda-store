import { StudioHomePage } from '@/components/StudioHome';
import { pageMetadata } from '@/lib/seo';
import { STUDIO_HOME } from '@/lib/studio-home';

const c = STUDIO_HOME['ar'];

export const metadata = pageMetadata('ar', '', c.meta.title, c.meta.desc, 'studio');

export default function Page() {
  return <StudioHomePage locale="ar" />;
}
