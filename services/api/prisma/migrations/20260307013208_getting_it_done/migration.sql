/*
  Warnings:

  - A unique constraint covering the columns `[dashboardKeyId]` on the table `api_keys` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[dashboardProjectId]` on the table `projects` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "dashboardKeyId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "dashboardProjectId" TEXT,
ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_dashboardKeyId_key" ON "api_keys"("dashboardKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_dashboardProjectId_key" ON "projects"("dashboardProjectId");
