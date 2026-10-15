-- Ruling LEGAL-4 (Task 8): withdraw a legal_notice_sends row when its Inngest enqueue failed.
--
-- DELETE stays REVOKED on legal_notice_sends for ebda_app (the FOR ALL policy's USING is "any signed-in
-- user", so a plain DELETE grant would let a merchant delete an announcement). The send route needs ONE
-- narrow removal - compensating a failed enqueue so nothing is announced without an email run - so it goes
-- through this definer function, which refuses anyone but an ACTIVE super_admin (the acting user GUC).
CREATE OR REPLACE FUNCTION public.ebda_withdraw_legal_notice_send(p_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE n integer;
BEGIN
  IF NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_withdraw_legal_notice_send: super_admin required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.legal_notice_sends WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;
REVOKE ALL ON FUNCTION public.ebda_withdraw_legal_notice_send(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_withdraw_legal_notice_send(text) TO ebda_app;
