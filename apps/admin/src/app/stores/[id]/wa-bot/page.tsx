'use client';

/**
 * /stores/[id]/wa-bot — DEPRECATED. The 3 cards (BotMode + ServiceMenu
 * + MetaCatalog) moved into the master WhatsApp Integration tabset as
 * the "Bot Config" tab on 2026-05-28 to remove page-bouncing overlap.
 *
 * This thin redirect keeps existing bookmarks + nav links working.
 */

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function WaBotRedirect() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/stores/${params.id}/whatsapp?tab=bot-config`);
  }, [params.id, router]);

  return (
    <div className="flex items-center justify-center py-24">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
