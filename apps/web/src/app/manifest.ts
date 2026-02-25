import type { MetadataRoute } from 'next';
import { getStore } from '../lib/store-resolver';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const store = await getStore();

  return {
    name: store.name,
    short_name: store.name,
    description: store.metaDescription || `Shop at ${store.name}`,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: store.theme?.primaryColor || '#ff6e00',
    icons: [
      ...(store.favicon
        ? [
            { src: store.favicon, sizes: '192x192', type: 'image/png' },
            { src: store.favicon, sizes: '512x512', type: 'image/png' },
          ]
        : [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }]),
    ],
  };
}
