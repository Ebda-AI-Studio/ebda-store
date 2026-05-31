-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percentage', 'fixed');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "discount_type" "DiscountType",
ADD COLUMN     "discount_value" INTEGER;
