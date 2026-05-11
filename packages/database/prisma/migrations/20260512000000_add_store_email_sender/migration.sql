-- Per-store branded email sender state.
-- Platform-managed under a single Resend account; admin UI surfaces the
-- merged Vercel + Resend DNS list invisibly.
ALTER TABLE "stores"
  ADD COLUMN "email_sender_local_part" TEXT NOT NULL DEFAULT 'noreply',
  ADD COLUMN "email_domain_id" TEXT,
  ADD COLUMN "email_domain_status" TEXT,
  ADD COLUMN "email_domain_verified_at" TIMESTAMP(3);
