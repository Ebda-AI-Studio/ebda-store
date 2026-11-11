'use client';

/**
 * Super-admin answer-engine provider config — /answer-engine-providers
 *
 * Lets a super-admin turn on the paid opt-in AEO/GEO check engines
 * (Perplexity, OpenAI) by entering an API key and flipping "enabled".
 * Gemini is always active on the platform's own key and needs no row here
 * (see apps/api/src/services/answer-engine/registry.ts).
 *
 * SECRET HANDLING (Task 5): the API key field NEVER shows the real key —
 * GET returns it masked (`sk_a****1234`). Submitting the field UNCHANGED
 * (still containing the masked value) does not overwrite the stored key;
 * only typing a genuinely new value replaces it. See
 * apps/api/src/services/answer-engine/config.service.ts.
 *
 * Data: GET/PUT /api/v1/admin/answer-engine/providers[/:engine]
 * Route guard: super_admin only — store_admins are redirected to 404.
 *
 * Bilingual EN + AR throughout (mirrors apps/admin/src/app/ai-usage/page.tsx).
 */

import { Button } from '@/components/ui/Button';
import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';
import { FIELD_CLASSES } from '@/components/ui/tokens';

// ── Types ────────────────────────────────────────────────────────────────

export type PaidEngine = 'perplexity' | 'openai';

export interface ProviderConfig {
  engine: PaidEngine;
  enabled: boolean;
  apiKeyMasked: string | null;
}

// ── Row: one paid engine ─────────────────────────────────────────────────

export function ProviderRow({
  config,
  onSaved,
}: {
  config: ProviderConfig;
  onSaved: (next: ProviderConfig) => void;
}) {
  const t = useT('answerEngineProviders');
  const meta = {
    label: t(`engines.${config.engine}.label` as Parameters<typeof t>[0]),
    hint: t(`engines.${config.engine}.hint` as Parameters<typeof t>[0]),
  };
  const [apiKey, setApiKey] = useState(config.apiKeyMasked ?? '');
  const [enabled, setEnabled] = useState(config.enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setApiKey(config.apiKeyMasked ?? '');
    setEnabled(config.enabled);
  }, [config.apiKeyMasked, config.enabled]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    // Send the field verbatim — if the admin never touched it, it still
    // contains the masked sentinel and the API leaves the stored key alone.
    // A genuinely new value (no `****`) is encrypted and replaces it.
    // The route wraps its response as `{ config }` (mirrors the plural GET's
    // `{ configs }`, already unwrapped correctly below at setConfigs(data.
    // configs)) — apiPut's generic type param must match that shape, or TS
    // silently believes `data` IS the ProviderConfig when it is really
    // `{ config: ProviderConfig }` one level up.
    const { data, error } = await apiPut<{ config: ProviderConfig }>(
      `/api/v1/admin/answer-engine/providers/${config.engine}`,
      // clear-gate-allow: the provider API has no clear form for a stored key
      // — `upsertBodySchema` is `z.string().min(1).optional()` (no null) and
      // there is no DELETE route, so an empty field must mean "leave the
      // encrypted key alone". Turning the provider off is `enabled: false`.
      // Removing a stored key needs a new endpoint (product decision).
      { apiKey: apiKey || undefined, enabled }
    );
    setSaving(false);
    if (error || !data) {
      setMessage(t('saveFailed', { message: error?.message || t('genericError') }));
      return;
    }
    onSaved(data.config);
    setMessage(t('saved'));
  };

  const hasKey = !!config.apiKeyMasked;

  return (
    <div className="rounded-md border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            config.enabled ? 'bg-success/10 text-success-ink' : 'bg-muted text-muted-foreground'
          }`}
        >
          {config.enabled ? t('statusActive') : t('statusOff')}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <label
            className="mb-1 block text-sm font-medium text-muted-foreground"
            htmlFor={`apikey-${config.engine}`}
          >
            {t('apiKeyLabel')} {hasKey ? t('apiKeyMaskedHint') : ''}
          </label>
          <input
            id={`apikey-${config.engine}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={hasKey ? t('apiKeyPlaceholderMasked') : t('apiKeyPlaceholderEmpty')}
            className={FIELD_CLASSES}
          />
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded-md border-input"
          />
          {t('enabledLabel')}
        </label>

        <Button type="button" onClick={save} disabled={saving}>
          {saving ? t('savingButton') : t('saveButton')}
        </Button>
      </div>

      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

// ── Gemini (platform key, no row) ─────────────────────────────────────────

function GeminiCard() {
  const t = useT('answerEngineProviders');
  return (
    <div className="rounded-md border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{t('geminiTitle')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('geminiHint')}</p>
        </div>
        <span className="inline-flex items-center rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success-ink">
          {t('geminiActiveBadge')}
        </span>
      </div>
    </div>
  );
}

// ── Page inner (needs RequireSuperAdmin wrapper) ─────────────────────────

function AnswerEngineProvidersPageInner() {
  const t = useT('answerEngineProviders');
  const [configs, setConfigs] = useState<ProviderConfig[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchConfigs = useCallback(async () => {
    setError(false);
    try {
      const { data, error: apiError } = await apiGet<{ configs: ProviderConfig[] }>(
        '/api/v1/admin/answer-engine/providers'
      );
      if (apiError || !data) {
        setError(true);
        return;
      }
      setConfigs(data.configs);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !configs) {
    return (
      <div className="rounded-md border bg-card p-8 text-center">
        <p className="text-sm text-destructive-ink">{t('loadFailedBody')}</p>
        <Button variant="link" size="sm" type="button" onClick={fetchConfigs} className="mt-4">
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <GeminiCard />
      {configs.map(config => (
        <ProviderRow
          key={config.engine}
          config={config}
          onSaved={next =>
            setConfigs(prev => (prev ?? []).map(c => (c.engine === next.engine ? next : c)))
          }
        />
      ))}
    </div>
  );
}

// ── Page export (wrapped in super_admin guard) ───────────────────────────

export default function AnswerEngineProvidersPage() {
  const t = useT('answerEngineProviders');
  return (
    <AdminLayout title={t('pageTitle')} subtitle={t('pageSubtitle')} mode="super_admin">
      <RequireSuperAdmin>
        <div className="p-4 sm:p-6">
          <AnswerEngineProvidersPageInner />
        </div>
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
