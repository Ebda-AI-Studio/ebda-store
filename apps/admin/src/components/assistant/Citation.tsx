'use client';

import Link from 'next/link';
import { ExternalLink, MapPin } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { hrefForPath, safeHref, type AssistantSegment } from '@/lib/assistant';

/** One reply as text and links only. Reply text is plain text: no HTML, no markdown, no image element, so what the server sends can never inject markup. */
export function Segments({
  segments,
  storeId,
  onNavigate,
}: {
  segments: AssistantSegment[];
  storeId: string;
  onNavigate: () => void;
}) {
  const t = useT('assistant');
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'text')
          return (
            <span key={i} dir="auto">
              {s.text}
            </span>
          );
        if (s.kind === 'cap') {
          const href = hrefForPath(s.appPath, storeId);
          return href ? (
            <Link
              key={i}
              href={href}
              onClick={onNavigate}
              className={buttonVariants({
                variant: 'soft',
                size: 'sm',
                className: 'mx-0.5 gap-1.5 align-middle',
              })}
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {t('showMe')}: <span dir="auto">{s.label}</span>
              </span>
            </Link>
          ) : (
            <span key={i} dir="auto">
              {s.label}
            </span>
          );
        }
        const href = safeHref(s.kind === 'cite' ? s.url : s.href);
        const label = s.kind === 'cite' ? s.title : s.text;
        return href ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({
              variant: 'outline',
              size: 'sm',
              className: 'mx-0.5 gap-1.5 align-middle',
            })}
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            <span dir="auto">{s.kind === 'cite' ? `${t('source')}: ${label}` : label}</span>
          </a>
        ) : (
          <span key={i} dir="auto">
            {label}
          </span>
        );
      })}
    </>
  );
}
