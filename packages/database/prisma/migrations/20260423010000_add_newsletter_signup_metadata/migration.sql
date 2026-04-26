-- Newsletter signups need to track which language the visitor was using
-- (so admin campaigns can target the right list) and where the signup came
-- from (footer / popup / manual import). Both columns are nullable so existing
-- rows survive the migration without a backfill.
ALTER TABLE "newsletter_subscribers" ADD COLUMN "language" TEXT;
ALTER TABLE "newsletter_subscribers" ADD COLUMN "source" TEXT;
