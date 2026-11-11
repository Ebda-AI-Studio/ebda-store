-- Per-request nonce on throttle rows (Issue 664): the account-cap statement recognises THIS request's own address rows by
-- nonce, never by a time comparison. Expand-only: nullable, old rows and old code are unaffected.
ALTER TABLE login_attempts ADD COLUMN nonce TEXT;
