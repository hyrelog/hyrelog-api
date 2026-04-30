-- CreateEnum
CREATE TYPE "GlacierRestoreStatus" AS ENUM ('PENDING', 'APPROVED', 'INITIATING', 'IN_PROGRESS', 'COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GlacierRestoreTier" AS ENUM ('EXPEDITED', 'STANDARD', 'BULK');

-- AlterTable: Add restoredUntil to archive_objects
ALTER TABLE "archive_objects" ADD COLUMN IF NOT EXISTS "restoredUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "archive_objects_restoredUntil_idx" ON "archive_objects"("restoredUntil");

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "targetCompanyId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "traceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glacier_restore_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "archiveId" TEXT NOT NULL,
    "requestedByType" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tier" "GlacierRestoreTier" NOT NULL,
    "days" INTEGER,
    "status" "GlacierRestoreStatus" NOT NULL DEFAULT 'PENDING',
    "s3RestoreId" TEXT,
    "initiatedAt" TIMESTAMP(3),
    "initiatedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "estimatedCostUsd" DECIMAL(10,4),
    "actualCostUsd" DECIMAL(10,4),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,

    CONSTRAINT "glacier_restore_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_targetCompanyId_idx" ON "audit_logs"("targetCompanyId");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_idx" ON "audit_logs"("actorUserId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "glacier_restore_requests_companyId_status_idx" ON "glacier_restore_requests"("companyId", "status");

-- CreateIndex
CREATE INDEX "glacier_restore_requests_archiveId_idx" ON "glacier_restore_requests"("archiveId");

-- CreateIndex
CREATE INDEX "glacier_restore_requests_status_requestedAt_idx" ON "glacier_restore_requests"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_targetCompanyId_fkey" FOREIGN KEY ("targetCompanyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glacier_restore_requests" ADD CONSTRAINT "glacier_restore_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glacier_restore_requests" ADD CONSTRAINT "glacier_restore_requests_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archive_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
