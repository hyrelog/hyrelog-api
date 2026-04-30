-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('JSONL', 'CSV');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ExportSource" AS ENUM ('HOT', 'ARCHIVED', 'HOT_AND_ARCHIVED');

-- AlterTable: Add rowCount and verification fields to archive_objects
ALTER TABLE "archive_objects" ADD COLUMN IF NOT EXISTS "rowCount" INTEGER;
ALTER TABLE "archive_objects" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "archive_objects" ADD COLUMN IF NOT EXISTS "verificationError" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "archive_objects_verifiedAt_idx" ON "archive_objects"("verifiedAt");

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "projectId" TEXT,
    "requestedByType" TEXT NOT NULL,
    "requestedById" TEXT,
    "source" "ExportSource" NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "filters" JSONB,
    "rowLimit" BIGINT NOT NULL,
    "rowsExported" BIGINT NOT NULL DEFAULT 0,
    "fileS3Key" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job_chunks" (
    "id" TEXT NOT NULL,
    "exportJobId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "s3Key" TEXT,
    "sha256" TEXT,
    "rows" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_job_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_jobs_companyId_status_createdAt_idx" ON "export_jobs"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "export_jobs_status_idx" ON "export_jobs"("status");

-- CreateIndex
CREATE INDEX "export_jobs_companyId_idx" ON "export_jobs"("companyId");

-- CreateIndex
CREATE INDEX "export_job_chunks_exportJobId_idx" ON "export_job_chunks"("exportJobId");

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job_chunks" ADD CONSTRAINT "export_job_chunks_exportJobId_fkey" FOREIGN KEY ("exportJobId") REFERENCES "export_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

