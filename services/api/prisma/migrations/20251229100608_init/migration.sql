-- CreateEnum
CREATE TYPE "Region" AS ENUM ('US', 'EU', 'UK', 'AU');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('COMPANY', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "CompanyMemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "GdprRequestStatus" AS ENUM ('CUSTOMER_PENDING', 'CUSTOMER_APPROVED', 'HYRELOG_APPROVED', 'PROCESSING', 'DONE', 'REJECTED');

-- CreateEnum
CREATE TYPE "GdprApprovalType" AS ENUM ('CUSTOMER_ADMIN', 'HYRELOG_ADMIN');

-- CreateEnum
CREATE TYPE "ColdStorageProvider" AS ENUM ('AWS', 'AZURE', 'GCP');

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dataRegion" "Region" NOT NULL DEFAULT 'US',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_members" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "CompanyMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "companyId" TEXT,
    "workspaceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "ipAllowlist" TEXT[],
    "labels" TEXT[],
    "rotatedFromId" TEXT,
    "rotatedToId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "lastUsedEndpoint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL,
    "traceId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "geo" TEXT,
    "userAgent" TEXT,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,
    "dataRegion" "Region" NOT NULL DEFAULT 'US',
    "archivalCandidate" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "isColdArchived" BOOLEAN NOT NULL DEFAULT false,
    "coldArchiveKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "region_data_stores" (
    "id" TEXT NOT NULL,
    "region" "Region" NOT NULL,
    "dbUrl" TEXT NOT NULL,
    "readOnlyUrl" TEXT,
    "s3Bucket" TEXT NOT NULL,
    "coldStorageProvider" "ColdStorageProvider" NOT NULL DEFAULT 'AWS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "region_data_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_objects" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "region" "Region" NOT NULL,
    "date" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "gzSizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "isColdArchived" BOOLEAN NOT NULL DEFAULT false,
    "coldArchiveKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gdpr_requests" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetValue" TEXT NOT NULL,
    "requestType" TEXT NOT NULL DEFAULT 'ANONYMIZE',
    "status" "GdprRequestStatus" NOT NULL DEFAULT 'CUSTOMER_PENDING',
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAtCustomer" TIMESTAMP(3),
    "approvedAtHyrelog" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "gdpr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gdpr_approvals" (
    "id" TEXT NOT NULL,
    "gdprRequestId" TEXT NOT NULL,
    "approverType" "GdprApprovalType" NOT NULL,
    "approverMemberId" TEXT,
    "approverEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gdpr_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "companies_dataRegion_idx" ON "companies"("dataRegion");

-- CreateIndex
CREATE INDEX "company_members_companyId_idx" ON "company_members"("companyId");

-- CreateIndex
CREATE INDEX "company_members_email_idx" ON "company_members"("email");

-- CreateIndex
CREATE UNIQUE INDEX "company_members_companyId_email_key" ON "company_members"("companyId", "email");

-- CreateIndex
CREATE INDEX "workspaces_companyId_idx" ON "workspaces"("companyId");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE INDEX "api_keys_hashedKey_idx" ON "api_keys"("hashedKey");

-- CreateIndex
CREATE INDEX "api_keys_companyId_idx" ON "api_keys"("companyId");

-- CreateIndex
CREATE INDEX "api_keys_workspaceId_idx" ON "api_keys"("workspaceId");

-- CreateIndex
CREATE INDEX "api_keys_scope_status_idx" ON "api_keys"("scope", "status");

-- CreateIndex
CREATE INDEX "audit_events_companyId_idx" ON "audit_events"("companyId");

-- CreateIndex
CREATE INDEX "audit_events_workspaceId_idx" ON "audit_events"("workspaceId");

-- CreateIndex
CREATE INDEX "audit_events_projectId_idx" ON "audit_events"("projectId");

-- CreateIndex
CREATE INDEX "audit_events_timestamp_idx" ON "audit_events"("timestamp");

-- CreateIndex
CREATE INDEX "audit_events_category_idx" ON "audit_events"("category");

-- CreateIndex
CREATE INDEX "audit_events_action_idx" ON "audit_events"("action");

-- CreateIndex
CREATE INDEX "audit_events_dataRegion_idx" ON "audit_events"("dataRegion");

-- CreateIndex
CREATE INDEX "audit_events_archived_archivalCandidate_idx" ON "audit_events"("archived", "archivalCandidate");

-- CreateIndex
CREATE INDEX "audit_events_hash_idx" ON "audit_events"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "region_data_stores_region_key" ON "region_data_stores"("region");

-- CreateIndex
CREATE INDEX "archive_objects_companyId_idx" ON "archive_objects"("companyId");

-- CreateIndex
CREATE INDEX "archive_objects_region_date_idx" ON "archive_objects"("region", "date");

-- CreateIndex
CREATE INDEX "archive_objects_isColdArchived_idx" ON "archive_objects"("isColdArchived");

-- CreateIndex
CREATE UNIQUE INDEX "archive_objects_companyId_workspaceId_region_date_key" ON "archive_objects"("companyId", "workspaceId", "region", "date");

-- CreateIndex
CREATE INDEX "gdpr_requests_companyId_idx" ON "gdpr_requests"("companyId");

-- CreateIndex
CREATE INDEX "gdpr_requests_status_idx" ON "gdpr_requests"("status");

-- CreateIndex
CREATE INDEX "gdpr_requests_createdAt_idx" ON "gdpr_requests"("createdAt");

-- CreateIndex
CREATE INDEX "gdpr_approvals_gdprRequestId_idx" ON "gdpr_approvals"("gdprRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "gdpr_approvals_gdprRequestId_approverType_approverMemberId_key" ON "gdpr_approvals"("gdprRequestId", "approverType", "approverMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "gdpr_approvals_gdprRequestId_approverType_approverEmail_key" ON "gdpr_approvals"("gdprRequestId", "approverType", "approverEmail");

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_objects" ADD CONSTRAINT "archive_objects_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_objects" ADD CONSTRAINT "archive_objects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gdpr_requests" ADD CONSTRAINT "gdpr_requests_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gdpr_approvals" ADD CONSTRAINT "gdpr_approvals_gdprRequestId_fkey" FOREIGN KEY ("gdprRequestId") REFERENCES "gdpr_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gdpr_approvals" ADD CONSTRAINT "gdpr_approvals_approverMemberId_fkey" FOREIGN KEY ("approverMemberId") REFERENCES "company_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
