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

import { useEffect, useState, useCallback } from 'react';
import { AdminLayout } from '../../components/AdminLayout';
import { RequireSuperAdmin } from '../../components/RequireSuperAdmin';
import { apiGet, apiPut } from '../../lib/api';

// ── Types ────────────────────────────────────────────────────────────────

type PaidEngine = 'perplexity' | 'openai';

interface ProviderConfig {
  engine: PaidEngine;
  enabled: boolean;
  apiKeyMasked: string | null;
}

const ENGINE_META: Record<PaidEngine, { label: string; labelAr: string; hint: string }> = {
  perplexity: {
    label: 'Perplexity (Sonar)',
    labelAr: 'بيربلكسيتي (سونار)',
    hint: 'Web-grounded answers via the Perplexity Sonar API.',
  },
  openai: {
    label: 'OpenAI (Responses API + web search)',
    labelAr: 'أوبن إيه آي (بحث ويب)',
    hint: 'Web-grounded answers via the OpenAI Responses API.',
  },
};

// ── Row: one paid engine ─────────────────────────────────────────────────

function ProviderRow({
  config,
  onSaved,
}: {
  config: ProviderConfig;
  onSaved: (next: ProviderConfig) => void;
}) {
  const meta = ENGINE_META[config.engine];
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
    const { data, error } = await apiPut<ProviderConfig>(
      `/api/v1/admin/answer-engine/providers/${config.engine}`,
      { apiKey: apiKey || undefined, enabled }
    );
    setSaving(false);
    if (error || !data) {
      setMessage(`Save failed / فشل الحفظ: ${error?.message || 'error'}`);
      return;
    }
    onSaved(data);
    setMessage('Saved / تم الحفظ');
  };

  const hasKey = !!config.apiKeyMasked;

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">{meta.label}</h3>
          <p className="text-sm text-muted-foreground/80" dir="rtl">
            {meta.labelAr}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            config.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'
          }`}
        >
          {config.enabled ? 'Active / نشط' : 'Off / متوقف'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor={`apikey-${config.engine}`}
          >
            API key / مفتاح الـ API {hasKey ? '(masked — leave as-is to keep it)' : ''}
          </label>
          <input
            id={`apikey-${config.engine}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={hasKey ? 'sk_****' : 'Enter API key / أدخل مفتاح الـ API'}
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        <label className="flex items-center gap-2 pb-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Enabled / تفعيل
        </label>

        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? 'Saving… / جارٍ الحفظ' : 'Save / حفظ'}
        </button>
      </div>

      {message && <p className="mt-2 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

// ── Gemini (platform key, no row) ─────────────────────────────────────────

function GeminiCard() {
  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Gemini</h3>
          <p className="text-sm text-muted-foreground/80" dir="rtl">
            جيميناي
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Always active on the platform&apos;s own key — no per-provider config needed.
          </p>
        </div>
        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
          Active (platform key) / نشط (مفتاح المنصة)
        </span>
      </div>
    </div>
  );
}

// ── Page inner (needs RequireSuperAdmin wrapper) ─────────────────────────

function AnswerEngineProvidersPageInner() {
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
      <div className="rounded-xl border bg-card p-8 text-center">
        <p className="text-sm text-destructive">Failed to load answer-engine provider config.</p>
        <p className="text-xs text-muted-foreground mt-1" dir="rtl">
          تعذّر تحميل إعدادات محركات الإجابة.
        </p>
        <button
          type="button"
          onClick={fetchConfigs}
          className="mt-4 text-sm text-primary hover:underline"
        >
          Retry / إعادة المحاولة
        </button>
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
  return (
    <AdminLayout
      title="Answer-engine providers / محركات الإجابة"
      subtitle="Enable Perplexity/OpenAI checks with an API key. Gemini runs on the platform key by default."
      mode="super_admin"
    >
      <RequireSuperAdmin>
        <div className="p-4 sm:p-6">
          <AnswerEngineProvidersPageInner />
        </div>
      </RequireSuperAdmin>
    </AdminLayout>
  );
}
