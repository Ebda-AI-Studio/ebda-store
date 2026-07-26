-- CreateEnum
CREATE TYPE "SlugEntityType" AS ENUM ('PRODUCT', 'CATEGORY', 'PAGE', 'BLOG');

-- CreateTable
CREATE TABLE "SlugRedirect" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "entityType" "SlugEntityType" NOT NULL,
    "fromSlug" TEXT NOT NULL,
    "toSlug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlugRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlugRedirect_storeId_entityType_fromSlug_key" ON "SlugRedirect"("storeId", "entityType", "fromSlug");

-- CreateIndex
CREATE INDEX "SlugRedirect_storeId_entityType_toSlug_idx" ON "SlugRedirect"("storeId", "entityType", "toSlug");

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
