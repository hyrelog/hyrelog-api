/*
  Warnings:

  - A unique constraint covering the columns `[dashboardCompanyId]` on the table `companies` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[dashboardWorkspaceId]` on the table `workspaces` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "dashboardCompanyId" TEXT;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "dashboardWorkspaceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "companies_dashboardCompanyId_key" ON "companies"("dashboardCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_dashboardWorkspaceId_key" ON "workspaces"("dashboardWorkspaceId");
