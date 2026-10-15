-- Rollback of 20261017000200_legal_notice_send_withdraw. Revert the service change first.
DROP FUNCTION IF EXISTS public.ebda_withdraw_legal_notice_send(text);
