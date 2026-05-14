-- Saved Explorer Views: named reusable Event Explorer query presets (canonical EventQuery JSON).

CREATE TABLE "saved_explorer_views" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "query" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_explorer_views_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_explorer_views_companyId_idx" ON "saved_explorer_views"("companyId");
CREATE INDEX "saved_explorer_views_companyId_workspaceId_idx" ON "saved_explorer_views"("companyId", "workspaceId");

ALTER TABLE "saved_explorer_views" ADD CONSTRAINT "saved_explorer_views_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saved_explorer_views" ADD CONSTRAINT "saved_explorer_views_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
