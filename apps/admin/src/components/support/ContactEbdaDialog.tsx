'use client';

/**
 * "Contact Ebda Store" (SELF-SERVICE A14). ONE dialog mounted once in the admin layout; any "contact support" copy
 * opens it through `openContactEbda()` / <ContactEbdaButton>, so the topic and the page the merchant was on travel
 * with the request. Needs a store in scope (the request is filed against it).
 */
import { useEffect, useState } from 'react';
import { Modal } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { RequestForm } from './RequestForm';

const EVENT = 'ebda:open-contact';

function openContactEbda(topic?: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { topic } }));
}

export function ContactEbdaButton({
  topic,
  className,
  variant = 'outline',
}: {
  topic?: string;
  className?: string;
  variant?: 'outline' | 'ghost';
}) {
  const t = useT('components.support');
  return (
    <Button
      variant={variant}
      type="button"
      className={className}
      onClick={() => openContactEbda(topic)}
    >
      {t('open')}
    </Button>
  );
}

export function ContactEbdaDialog({ storeId }: { storeId: string | null }) {
  const t = useT('components.support');
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<string | undefined>();

  useEffect(() => {
    const on = (e: Event) => {
      setTopic((e as CustomEvent<{ topic?: string }>).detail?.topic);
      setOpen(true);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);

  if (!storeId) return null;
  return (
    <Modal isOpen={open} onClose={() => setOpen(false)} title={t('title')} size="md">
      {/* remount per open so a sent form does not linger */}
      {open && (
        <RequestForm
          mode="support"
          storeId={storeId}
          topic={topic}
          onDone={() => undefined}
          onCancel={() => setOpen(false)}
        />
      )}
    </Modal>
  );
}
