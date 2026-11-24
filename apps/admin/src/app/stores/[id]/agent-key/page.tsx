'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Modal, useToast } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { AdminLayout } from '../../../../components/AdminLayout';
import { useRequireFeature } from '../../../../hooks/useRequireFeature';
import { apiDelete, apiGet, apiPost } from '../../../../lib/api';
import { useT } from '@/i18n/useT';
import { AgentKeyPanel, type AgentKeyStatus } from './_components/AgentKeyPanel';

/**
 * Merchant screen for the MCP agent write credential — mint, rotate, revoke.
 *
 * ## Why this page exists, and why HERE
 *
 * The credential shipped API-only (parent PR #1617), which is the shape this
 * repo explicitly refuses: every table whose rows have business meaning needs a
 * UI, and "mint it with a curl" is not one. `Store.agentApiKey` decides whether
 * a merchant's agent checkout works at all, so it is exactly that shape.
 *
 * It is a DEDICATED page rather than another toggle: UI rule 4 caps ThemeTab at
 * 7 toggles and sends the next merchant-facing control to its own
 * `/stores/[id]/<feature>` page under the right sidebar group — and this is not
 * a toggle in any case. It is a credential lifecycle with a one-time secret
 * reveal and an irreversible destructive action, none of which fits a switch.
 * It sits in the SETTINGS hub (its `/agent-key` prefix is registered in
 * `hubs.ts`) because it is integration
 * configuration, not a marketing surface. It is reachable from the Settings card
 * grid and the ⌘K palette, both gated on `agent_checkout`.
 *
 * ## Once-only display
 *
 * The plaintext key exists in this browser exactly once, in `mintedKey` state,
 * for as long as the reveal modal is open. It is never written to
 * `localStorage`, never put in the URL, never re-fetched and never re-derivable:
 * `GET .../agent-key` returns `hasKey` and `rotatedAt` and nothing else, by
 * construction (see the route's own comment, and the
 * `agent-key-status-never-returns-the-key` defence mutation). Closing the modal
 * clears the state and there is no path back to it — a lost key is ROTATED, not
 * recovered. That is also why rotate is behind its own confirmation: it
 * invalidates the previous key with no overlap window, so a merchant who rotates
 * to "have a look at the key again" has just broken their live integration.
 */

interface MintResponse {
  apiKey: string;
  header: string;
  rotated: boolean;
  message: string;
}

export default function AgentKeyPage() {
  const { gate } = useRequireFeature('agent_checkout');

  const params = useParams();
  const storeId = params?.id as string;
  const t = useT('agentKey');
  const { success: toastSuccess, error: toastError } = useToast();

  const [status, setStatus] = useState<AgentKeyStatus | null>(null);
  const [busy, setBusy] = useState<'issue' | 'revoke' | null>(null);

  // The one-time reveal. State only — never persisted anywhere.
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeAcknowledged, setRevokeAcknowledged] = useState(false);

  const endpoint = `/api/v1/stores/${storeId}/integrations/agent-key`;

  const loadStatus = useCallback(async () => {
    if (!storeId) return;
    const { data, error } = await apiGet<AgentKeyStatus>(endpoint);
    if (error) {
      toastError(t('toast.loadFailedTitle'), error.message);
      return;
    }
    if (data) setStatus(data);
  }, [storeId, endpoint, toastError, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /** Mint or rotate. The ONLY call that ever receives the plaintext. */
  const issueKey = useCallback(async () => {
    setBusy('issue');
    const { data, error } = await apiPost<MintResponse>(endpoint);
    setBusy(null);
    setRotateOpen(false);
    if (error || !data) {
      toastError(t('toast.issueFailedTitle'), error?.message ?? t('toast.issueFailedBody'));
      return;
    }
    setCopied(false);
    setMintedKey(data.apiKey);
    toastSuccess(data.rotated ? t('toast.rotated') : t('toast.minted'));
    await loadStatus();
  }, [endpoint, loadStatus, toastError, toastSuccess, t]);

  const revokeKey = useCallback(async () => {
    setBusy('revoke');
    const { error } = await apiDelete(endpoint);
    setBusy(null);
    setRevokeOpen(false);
    setRevokeAcknowledged(false);
    if (error) {
      toastError(t('toast.revokeFailedTitle'), error.message);
      return;
    }
    toastSuccess(t('toast.revoked'));
    await loadStatus();
  }, [endpoint, loadStatus, toastError, toastSuccess, t]);

  const handleIssue = useCallback(() => {
    // Minting the FIRST key breaks nothing, so it needs no confirmation.
    // Rotating replaces a key that something live may be using right now.
    if (status?.hasKey) setRotateOpen(true);
    else void issueKey();
  }, [status, issueKey]);

  const copyKey = useCallback(async () => {
    if (!mintedKey) return;
    try {
      await navigator.clipboard.writeText(mintedKey);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (permissions, insecure context). The key is
      // on screen and selectable, so this is a convenience, not the delivery
      // mechanism — never surface a failure that implies the key was lost.
      setCopied(false);
    }
  }, [mintedKey]);

  const dismissReveal = useCallback(() => {
    // The point of the whole feature: after this there is no way back to it.
    setMintedKey(null);
    setCopied(false);
  }, []);

  if (gate) return gate;

  return (
    <AdminLayout title={t('page.title')} subtitle={t('page.subtitle')}>
      <div className="max-w-2xl">
        <AgentKeyPanel
          status={status}
          busy={busy}
          onIssue={handleIssue}
          onRevoke={() => {
            setRevokeAcknowledged(false);
            setRevokeOpen(true);
          }}
        />
      </div>

      {/* ── One-time reveal ─────────────────────────────────────────────────
          `onClose` is the same dismissal as the button: whichever way the
          merchant leaves, the key is gone. */}
      <Modal
        isOpen={mintedKey !== null}
        onClose={dismissReveal}
        title={t('reveal.title')}
        size="lg"
      >
        <div className="space-y-3">
          <p
            className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning-ink"
            dir="auto"
          >
            {t('reveal.warning')}
          </p>
          {/* Forced LTR + break-all: a base64url secret must never be
              bidi-reordered or wrapped mid-glyph in an Arabic admin. */}
          <code
            className="block w-full rounded-lg border bg-muted px-3 py-2 font-mono text-xs break-all text-foreground"
            dir="ltr"
          >
            {mintedKey}
          </code>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copyKey()}>
              {copied ? t('reveal.copied') : t('reveal.copy')}
            </Button>
            <Button type="button" size="sm" onClick={dismissReveal}>
              {t('reveal.done')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Rotate confirmation ─────────────────────────────────────────── */}
      <Modal isOpen={rotateOpen} onClose={() => setRotateOpen(false)} title={t('rotate.title')}>
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground" dir="auto">
            {t('rotate.body')}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRotateOpen(false)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void issueKey()}
              isLoading={busy === 'issue'}
              disabled={busy !== null}
            >
              {t('rotate.confirm')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Revoke confirmation ──────────────────────────────────────────────
          Revoking breaks a live integration with no undo and no way to restore
          the same key, so the destructive button stays disabled until the
          merchant has ticked an acknowledgement that states the consequence in
          their own language. */}
      <Modal isOpen={revokeOpen} onClose={() => setRevokeOpen(false)} title={t('revoke.title')}>
        <div className="space-y-3">
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs leading-relaxed text-foreground"
            dir="auto"
          >
            {t('revoke.body')}
          </p>
          <label className="flex items-start gap-2 text-sm text-foreground" dir="auto">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={revokeAcknowledged}
              onChange={e => setRevokeAcknowledged(e.target.checked)}
            />
            <span>{t('revoke.acknowledge')}</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRevokeOpen(false)}
              disabled={busy !== null}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => void revokeKey()}
              isLoading={busy === 'revoke'}
              disabled={busy !== null || !revokeAcknowledged}
            >
              {t('revoke.confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </AdminLayout>
  );
}
