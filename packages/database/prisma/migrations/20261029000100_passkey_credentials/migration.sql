-- 20261029000100_passkey_credentials (Ruling PASSKEY-1)
--
--   passkey_credentials  NEW, user-keyed. One row per registered WebAuthn credential (merchant/staff in the
--                        admin namespace, or a shopper of ONE store). Holds the PUBLIC key only.
--
-- User-keyed, not store-keyed, on purpose: the user row is already the tenant boundary (a shopper's
-- users.store_id; a merchant's NULL), so this follows refresh_tokens / legal_acceptances and carries NO
-- store_id column (a store_id column would pull the table into the strict store policy enumeration).
-- rp_id records the host the credential was minted for; sign-in refuses a credential whose rp_id is not the
-- host the request came from (custom-domain switch => old credentials stop matching, by design).
--
-- Additive, table empty at creation, plain CREATE INDEX (docs/DB-INDEX-MIGRATIONS.md); no lock_timeout.
-- FK users CASCADE (no NO ACTION child added). ebda_app gets CRUD from the default privileges of
-- 20261004000000_ebda_strict_rls. Rollback: rollback.sql next to this file.

CREATE TABLE "passkey_credentials" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "rp_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "passkey_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "passkey_credentials_device_type_check" CHECK ("device_type" IN ('singleDevice', 'multiDevice')),
    CONSTRAINT "passkey_credentials_counter_check" CHECK ("counter" >= 0)
);
CREATE UNIQUE INDEX "passkey_credentials_credential_id_key" ON "passkey_credentials"("credential_id");
CREATE INDEX "passkey_credentials_user_id_idx" ON "passkey_credentials"("user_id");
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Strict RLS: one FOR ALL policy, USING and WITH CHECK both keyed on the user GUC. No super_admin read path:
-- a credential is the user's own, an operator has no reason to list another account's keys.
ALTER TABLE "passkey_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "passkey_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_user_isolation ON "passkey_credentials" AS PERMISSIVE FOR ALL TO ebda_app
  USING (user_id = nullif(current_setting('app.current_user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.current_user_id', true), ''));

-- A presented credential id -> the row that authenticates it. UNGUARDED ON PURPOSE (like
-- ebda_refresh_token_user): discoverable sign-in knows only the credential id, so there is no user context
-- yet. It returns public material only (public key, counter, rp_id); the caller still has to produce a valid
-- signature over a server-issued challenge.
CREATE OR REPLACE FUNCTION public.ebda_passkey_lookup(p_credential_id text)
RETURNS TABLE (id text, user_id text, public_key text, counter bigint, transports text[], rp_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT c.id, c.user_id, c.public_key, c.counter, c.transports, c.rp_id
  FROM public.passkey_credentials c WHERE c.credential_id = p_credential_id LIMIT 1
$fn$;

-- Erasure: remove every passkey of a user. GUARDED like ebda_user_tokens_delete (the user, a super_admin, or
-- the merchant of the user's store).
CREATE OR REPLACE FUNCTION public.ebda_passkeys_delete(p_user_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.ebda_may_act_on_user(p_user_id) THEN
    RAISE EXCEPTION 'ebda_passkeys_delete: caller may not act on user %', p_user_id
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.passkey_credentials c WHERE c.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.ebda_passkey_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_passkey_lookup(text) TO ebda_app;
REVOKE ALL ON FUNCTION public.ebda_passkeys_delete(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_passkeys_delete(text) TO ebda_app;
