'use client';

/** The assistant's launcher and panel for one store. Renders nothing until the server says the assistant is on for this store; Ctrl/Cmd + J toggles it. */
import { CircleHelp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useT } from '@/i18n/useT';
import { getAssistantStatus } from '@/lib/assistant';
import { Button } from '@/components/ui/Button';
import { AssistantPanel } from './AssistantPanel';

export function AssistantDock({ storeId }: { storeId: string }) {
  const t = useT('assistant');
  const { user } = useAuth();
  const userId = user?.id ?? 'anonymous';
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setEnabled(false);
    setOpen(false);
    if (!storeId) return;
    void getAssistantStatus(storeId).then(r => {
      if (alive) setEnabled(r.data?.enabled === true);
    });
    return () => {
      alive = false;
    };
  }, [storeId]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  const close = useCallback(() => {
    setOpen(false);
    document.getElementById('assistant-launcher')?.focus();
  }, []);

  if (!enabled) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        id="assistant-launcher"
        aria-expanded={open}
        aria-controls="assistant-panel"
        aria-keyshortcuts="Control+J Meta+J"
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-20 end-4 z-40 shadow-lg lg:bottom-6"
      >
        <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
        <span>{t('title')}</span>
      </Button>
      {open && (
        <AssistantPanel
          storeId={storeId}
          userId={userId}
          onClose={close}
          onUnavailable={() => {
            setEnabled(false);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
