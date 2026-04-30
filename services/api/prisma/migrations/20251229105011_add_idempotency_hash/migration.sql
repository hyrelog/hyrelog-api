-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "idempotencyHash" TEXT;

-- CreateIndex
CREATE INDEX "audit_events_idempotencyHash_idx" ON "audit_events"("idempotencyHash");
