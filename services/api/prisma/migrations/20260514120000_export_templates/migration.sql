-- Export templates: saved filter presets for dashboard streaming exports (no stored artifacts).

CREATE TABLE "export_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "source" "ExportSource" NOT NULL DEFAULT 'HOT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "export_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "export_templates_companyId_idx" ON "export_templates"("companyId");
CREATE INDEX "export_templates_companyId_workspaceId_idx" ON "export_templates"("companyId", "workspaceId");

ALTER TABLE "export_templates" ADD CONSTRAINT "export_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "export_templates" ADD CONSTRAINT "export_templates_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
