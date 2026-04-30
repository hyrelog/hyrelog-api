-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('STANDARD', 'CUSTOM');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "planTier" "PlanTier" NOT NULL,
    "planType" "PlanType" NOT NULL DEFAULT 'STANDARD',
    "webhooksEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxWebhooks" INTEGER NOT NULL DEFAULT 0,
    "streamingExportsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxExportRows" BIGINT NOT NULL DEFAULT 10000,
    "hotRetentionDays" INTEGER NOT NULL DEFAULT 7,
    "archiveRetentionDays" INTEGER,
    "coldArchiveAfterDays" INTEGER,
    "allowCustomCategories" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE INDEX "plans_planType_idx" ON "plans"("planType");

-- CreateIndex
CREATE INDEX "plans_planTier_idx" ON "plans"("planTier");

-- CreateIndex
CREATE INDEX "plans_isActive_idx" ON "plans"("isActive");

-- AlterTable: Add planId as nullable first
ALTER TABLE "companies" ADD COLUMN "planId" TEXT;

-- CreateIndex
CREATE INDEX "companies_planId_idx" ON "companies"("planId");

-- Create default Free plan for existing companies (if any exist)
DO $$
DECLARE
    default_plan_id TEXT;
    company_count INTEGER;
BEGIN
    -- Check if there are any existing companies
    SELECT COUNT(*) INTO company_count FROM "companies";
    
    IF company_count > 0 THEN
        -- Create default Free plan
        INSERT INTO "plans" (
            "id",
            "name",
            "planTier",
            "planType",
            "webhooksEnabled",
            "maxWebhooks",
            "streamingExportsEnabled",
            "maxExportRows",
            "hotRetentionDays",
            "allowCustomCategories",
            "isDefault",
            "createdAt",
            "updatedAt"
        ) VALUES (
            gen_random_uuid()::text,
            'Free',
            'FREE',
            'STANDARD',
            false,
            0,
            false,
            10000,
            7,
            false,
            true,
            NOW(),
            NOW()
        ) RETURNING "id" INTO default_plan_id;
        
        -- Update existing companies to use default Free plan
        UPDATE "companies"
        SET "planId" = default_plan_id
        WHERE "planId" IS NULL;
    END IF;
END $$;

-- Now make planId NOT NULL (safe since all companies have planId or table is empty)
ALTER TABLE "companies" ALTER COLUMN "planId" SET NOT NULL;

-- AddForeignKey (now safe since all companies have valid planId)
ALTER TABLE "companies" ADD CONSTRAINT "companies_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
