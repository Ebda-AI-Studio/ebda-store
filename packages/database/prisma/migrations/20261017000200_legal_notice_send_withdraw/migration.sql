-- Ruling LEGAL-4 (Task 8): withdraw a legal_notice_sends row when its Inngest enqueue failed.
--
-- DELETE stays REVOKED on legal_notice_sends for ebda_app (the FOR ALL policy's USING is "any signed-in
-- user", so a plain DELETE grant would let a merchant delete an announcement). The send route needs ONE
-- narrow removal - compensating a failed enqueue so nothing is announced without an email run - so it goes
-- through this definer function. It deletes ONLY the row the caller just created and that nothing has
-- acted on yet:
--   * the caller is an ACTIVE super_admin (acting-user GUC) AND is the row's sent_by (your own click);
--   * recipient_count IS NULL (the fan-out never materialised recipients);
--   * no legal_notice_deliveries row exists for that doc_key + version;
--   * the row is at most 10 minutes old.
-- The row is locked FOR UPDATE first, and materializeDeliveries takes the same lock before its first
-- insert, so a fan-out that already started either holds the lock (this call waits, then sees its
-- deliveries and deletes nothing) or finds the row gone and aborts without emailing anyone.
-- Returns the number of rows deleted (0 = refused: the send may have started).
CREATE OR REPLACE FUNCTION public.ebda_withdraw_legal_notice_send(p_id text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  cur text := nullif(current_setting('app.current_user_id', true), '');
  s record;
BEGIN
  IF cur IS NULL OR NOT public.ebda_is_super_admin() THEN
    RAISE EXCEPTION 'ebda_withdraw_legal_notice_send: super_admin required' USING ERRCODE = '42501';
  END IF;
  SELECT id, doc_key, version, sent_by, recipient_count, sent_at INTO s
    FROM public.legal_notice_sends WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF s.sent_by <> cur OR s.recipient_count IS NOT NULL
     OR s.sent_at < now() - interval '10 minutes' THEN
    RETURN 0;
  END IF;
  -- A separate statement: after waiting on the lock this sees deliveries the fan-out committed.
  IF EXISTS (SELECT 1 FROM public.legal_notice_deliveries d
              WHERE d.doc_key = s.doc_key AND d.version = s.version) THEN
    RETURN 0;
  END IF;
  DELETE FROM public.legal_notice_sends WHERE id = s.id;
  RETURN 1;
END
$fn$;
REVOKE ALL ON FUNCTION public.ebda_withdraw_legal_notice_send(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ebda_withdraw_legal_notice_send(text) TO ebda_app;
