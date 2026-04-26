-- Epic E: OneSignal subscriptions for admin push notifications
CREATE TABLE "onesignal_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "onesignal_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onesignal_subscriptions_user_id_player_id_key" ON "onesignal_subscriptions"("user_id", "player_id");
CREATE INDEX "onesignal_subscriptions_user_id_idx" ON "onesignal_subscriptions"("user_id");

ALTER TABLE "onesignal_subscriptions"
    ADD CONSTRAINT "onesignal_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic A: Storefront layout settings JSONB on Store. Empty {} means
-- "use packaged defaults" (the Pecannbee flow), so existing tenants don't
-- need a backfill — the storefront resolves missing keys on read.
ALTER TABLE "stores" ADD COLUMN "layout_settings" JSONB NOT NULL DEFAULT '{}';
