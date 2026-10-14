'use client';

import { useT } from '@/i18n/useT';
import { IMAGE_STANDARDS } from '@ebda/shared';
import { ImageUpload } from '../../../../../components/ImageUpload';
import type { StoreBranding } from './types';

interface LogoUploaderProps {
  branding: StoreBranding;
  onChange: (branding: StoreBranding) => void;
  /** Tenant scope so uploads land under `stores/<storeId>/logos/...` in R2. */
  storeId: string;
}

const LOGO_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml';
const FAVICON_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon';

// Logo can be EITHER the horizontal wordmark (400×200, 2:1) OR a square
// brandmark (400×400, 1:1) — depends on the brand identity. Hint lists
// both so the merchant picks the one that matches their visual.
const LOGO_HINT = (() => {
  const wide = IMAGE_STANDARDS.storeLogo;
  const square = IMAGE_STANDARDS.storeLogoSquare;
  return `Recommended: ${wide.width}×${wide.height}px wordmark OR ${square.width}×${square.height}px square brandmark (${wide.formats.join(' / ')})`;
})();
const FAVICON_HINT = (() => {
  const f = IMAGE_STANDARDS.favicon;
  return `Recommended: ${f.width}×${f.height}px (${f.formats.join(' / ')})`;
})();

/**
 * Logo, Arabic logo, and favicon uploaders. Grouped together because they
 * share a layout row and all persist on the same branding PUT.
 */
export function LogoUploader({ branding, onChange, storeId }: LogoUploaderProps) {
  const t = useT('branding.identity');

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">{t('logo')}</label>
        <ImageUpload
          value={branding.logo}
          onUpload={url => onChange({ ...branding, logo: url })}
          onRemove={() => onChange({ ...branding, logo: '' })}
          folder="logos"
          storeId={storeId}
          label={t('logoUpload')}
          accept={LOGO_ACCEPT}
          recommendedSizeHint={LOGO_HINT}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">{t('logoAr')}</label>
        <ImageUpload
          value={branding.logoAr}
          onUpload={url => onChange({ ...branding, logoAr: url })}
          onRemove={() => onChange({ ...branding, logoAr: '' })}
          folder="logos"
          storeId={storeId}
          label={t('logoArUpload')}
          accept={LOGO_ACCEPT}
          recommendedSizeHint={LOGO_HINT}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">{t('favicon')}</label>
        <ImageUpload
          value={branding.favicon}
          onUpload={url => onChange({ ...branding, favicon: url })}
          onRemove={() => onChange({ ...branding, favicon: '' })}
          folder="logos"
          storeId={storeId}
          label={t('faviconUpload')}
          accept={FAVICON_ACCEPT}
          recommendedSizeHint={FAVICON_HINT}
        />
      </div>
    </div>
  );
}
