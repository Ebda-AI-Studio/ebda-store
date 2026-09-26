-- Migration: answer_engine_check_grounding_unavailable
--
-- Issue #929: `gemini.provider.ts` sent the legacy `googleSearchRetrieval`
-- grounding tool, which every 2.x-family model now rejects with HTTP 400 —
-- the "ChatGPT/Gemini cites your store" signal had never actually fired.
-- The fix (same PR) switches to the current `google_search` tool and, when
-- even that is unavailable on the configured model/key (retired alias,
-- rejected tool, exhausted quota — HTTP 400/404/429), falls back to an
-- ungrounded call rather than failing the scan.
--
-- That fallback needs a signal the dashboard can tell apart from a normal
-- grounded call that simply cited nothing — the existing `cited_urls`
-- emptiness proxy (`dashboard.service.ts`'s `groundedCaveat`) cannot
-- distinguish "grounding worked, found nothing" from "grounding could not
-- run at all". This column carries that distinct reason.
--
-- ADDITIVE AND NULLABLE BY CONSTRUCTION: every existing row, and every row
-- written by a provider that never sets it (Perplexity/OpenAI, or Gemini on
-- a normal grounded/ungrounded-by-design call), gets NULL — a strict no-op
-- for all current data and every other write path. No RLS policy change is
-- needed: `rls_answer_engine_checks_tenant` (see the
-- `20260722000000_answer_engine_check` migration) is a table-level tenant
-- predicate, not a column allowlist.

ALTER TABLE "answer_engine_checks"
    ADD COLUMN "grounding_unavailable_reason" TEXT;
