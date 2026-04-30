-- PlanTier: remove GROWTH, add PRO and BUSINESS; map existing GROWTH -> BUSINESS

CREATE TYPE "PlanTier_new" AS ENUM ('FREE', 'STARTER', 'PRO', 'BUSINESS', 'ENTERPRISE');

ALTER TABLE "companies" ALTER COLUMN "planTier" DROP DEFAULT;

ALTER TABLE "companies" ALTER COLUMN "planTier" TYPE "PlanTier_new" USING (
  CASE "planTier"::text
    WHEN 'GROWTH' THEN 'BUSINESS'::"PlanTier_new"
    ELSE "planTier"::text::"PlanTier_new"
  END
);

ALTER TABLE "plans" ALTER COLUMN "planTier" TYPE "PlanTier_new" USING (
  CASE "planTier"::text
    WHEN 'GROWTH' THEN 'BUSINESS'::"PlanTier_new"
    ELSE "planTier"::text::"PlanTier_new"
  END
);

DROP TYPE "PlanTier";

ALTER TYPE "PlanTier_new" RENAME TO "PlanTier";

ALTER TABLE "companies" ALTER COLUMN "planTier" SET DEFAULT 'FREE'::"PlanTier";

-- Rename legacy Growth catalog row if present (enum is already BUSINESS)
UPDATE "plans" SET "name" = 'Business', "description" = 'Business plan — higher limits and retention'
WHERE "name" = 'Growth' AND "planTier" = 'BUSINESS';
