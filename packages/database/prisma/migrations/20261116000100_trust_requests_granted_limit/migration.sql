-- trust_requests.granted_limit: the self-serve store limit staff granted when they RESOLVED a store_cap request.
-- Additive, nullable. NULL = nothing granted (the owner keeps MAX_SELF_SERVE_STORES_PER_OWNER).
ALTER TABLE "trust_requests" ADD COLUMN "granted_limit" INTEGER;
ALTER TABLE "trust_requests" ADD CONSTRAINT "trust_requests_granted_limit_check" CHECK ("granted_limit" IS NULL OR ("granted_limit" BETWEEN 1 AND 20 AND "kind" = 'store_cap'));
