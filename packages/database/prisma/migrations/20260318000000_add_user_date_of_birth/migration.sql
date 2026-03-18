-- Add date_of_birth to users for birthday bonus automation
ALTER TABLE "users" ADD COLUMN "date_of_birth" TIMESTAMP(3);
