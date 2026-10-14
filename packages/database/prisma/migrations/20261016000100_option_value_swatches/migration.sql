-- Colour swatch per option value (hex dot and/or a fabric/photo thumbnail).
-- product_option_values is a tenant child (RLS via product join, 20261004000000);
-- adding columns needs no policy change.
ALTER TABLE "product_option_values" ADD COLUMN "swatch_hex" TEXT;
ALTER TABLE "product_option_values" ADD COLUMN "swatch_image_url" TEXT;
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_swatch_hex_format"
  CHECK ("swatch_hex" IS NULL OR "swatch_hex" ~ '^#[0-9A-Fa-f]{6}$');
