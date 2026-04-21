-- Add COD (Cash on Delivery) to PaymentProvider enum
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'cod';

-- Add cod_pending status for COD orders awaiting cash collection
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'cod_pending';
