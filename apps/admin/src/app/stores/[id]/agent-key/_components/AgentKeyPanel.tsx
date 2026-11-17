'use client';

import { intlLocaleForUi } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { withNumerals } from '@ebda/shared';

/**
 * Read-only status + the three actions for the store's MCP agent write
 * credential. Presentational ONLY — every mutation is raised to the page, which
 * owns the confirm modals and the one-time reveal.
 *
 * Split out from `page.tsx` on purpose: this file is a pure function of its
 * props, so the three states a merchant can actually be in (no key / key
 * issued / escape hatch on) are renderable and assertable in a unit test.
 * `vitest`'s environment here is `node` with no jsdom or testing-library, so the
 * test renders this to static markup — which is only possible because nothing in
 * here reaches for a browser, a fetch, or a router.
 *
 * The credential itself NEVER appears in this component. `status` is the shape
 * `GET /stores/:id/integrations/agent-key` returns, which carries `hasKey` — a
 * boolean — and never the key or its ciphertext. The plaintext exists in this
 * app exactly once, in the page's own state, immediately after a mint.
 */

export interface AgentKeyStatus {
  /** Whether a credential is currently issued. NEVER the credential itself. */
  hasKey: boolean;
  /** ISO timestamp of the last mint / rotate / revoke, or null if never. */
  rotatedAt: string | null;
  /** Request header the agent presents the key in (`x-agent-key`). */
  header: string;
  /**
   * `agent_checkout_open_writes` — the per-store escape hatch (Ruling M2).
   * When ON, MCP writes are accepted with NO credential at all, so the key's
   * presence or absence stops meaning anything. Resolved server-side; see the
   * GET handler for why it is not read from `useFeatures()`.
   */
  openWrites: boolean;
}

interface AgentKeyPanelProps {
  /** `null` while the status request is in flight. */
  status: AgentKeyStatus | null;
  /** Which action is currently running, so both buttons can disable together. */
  busy: 'issue' | 'revoke' | null;
  /** Mint (no key yet) or rotate (key exists) — the page decides which confirm to show. */
  onIssue: () => void;
  /** Opens the revoke confirmation. Never revokes directly. */
  onRevoke: () => void;
}

function StatusChip({ tone, label }: { tone: 'green' | 'gray' | 'amber'; label: string }) {
  const chip =
    tone === 'green'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800'
      : tone === 'amber'
        ? 'bg-warning/10 text-warning-ink border-warning/40'
        : 'bg-muted text-muted-ink border-border';
  const dot =
    tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-warning' : 'bg-muted-foreground';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function AgentKeyPanel({ status, busy, onIssue, onRevoke }: AgentKeyPanelProps) {
  const t = useT('agentKey');

  if (!status) {
    return (
      <div className="space-y-3">
        <div className="h-24 rounded-xl border bg-card animate-pulse" />
        <div className="h-32 rounded-xl border bg-card animate-pulse" />
      </div>
    );
  }

  const rotatedLabel = status.rotatedAt
    ? new Date(status.rotatedAt).toLocaleString(intlLocaleForUi(), withNumerals())
    : null;

  return (
    <div className="space-y-4">
      {/* ── Escape hatch warning ─────────────────────────────────────────────
          Deliberately ABOVE the status card: while this is on, everything the
          status card says about the key is irrelevant, because writes are
          accepted without one. A merchant reading "no key issued" and
          concluding "so nothing can write" would be wrong. */}
      {status.openWrites && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4">
          <p className="text-sm font-semibold text-warning-ink" dir="auto">
            {t('hatch.title')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-warning-ink" dir="auto">
            {t('hatch.body')}
          </p>
        </div>
      )}

      {/* ── Status ─────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground" dir="auto">
            {t('status.heading')}
          </h2>
          {status.hasKey ? (
            <StatusChip tone="green" label={t('status.issued')} />
          ) : (
            <StatusChip tone="gray" label={t('status.notIssued')} />
          )}
        </div>

        <p className="mt-2 text-xs leading-relaxed text-muted-foreground" dir="auto">
          {status.hasKey ? t('status.issuedBody') : t('status.notIssuedBody')}
        </p>

        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground" dir="auto">
              {t('status.headerLabel')}
            </dt>
            {/* Forced LTR: the header name is an ASCII identifier and must not
                be re-ordered by the surrounding RTL paragraph direction. */}
            <dd className="mt-0.5 font-mono text-foreground" dir="ltr">
              {status.header}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground" dir="auto">
              {t('status.lastChangedLabel')}
            </dt>
            <dd className="mt-0.5 text-foreground" dir="auto">
              {rotatedLabel ?? t('status.never')}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={onIssue}
            disabled={busy !== null}
            isLoading={busy === 'issue'}
          >
            {status.hasKey ? t('actions.rotate') : t('actions.mint')}
          </Button>
          {status.hasKey && (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={onRevoke}
              disabled={busy !== null}
              isLoading={busy === 'revoke'}
            >
              {t('actions.revoke')}
            </Button>
          )}
        </div>
      </div>

      {/* ── How an agent uses it ───────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground" dir="auto">
          {t('howto.heading')}
        </h2>
        <ol className="mt-2 space-y-1.5 ps-4 text-xs leading-relaxed text-muted-foreground list-decimal">
          <li dir="auto">{t('howto.step1')}</li>
          <li dir="auto">{t('howto.step2')}</li>
          <li dir="auto">{t('howto.step3')}</li>
        </ol>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground" dir="auto">
          {t('howto.readsAreOpen')}
        </p>
      </div>
    </div>
  );
}
