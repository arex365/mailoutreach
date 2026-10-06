-- AlterTable
ALTER TABLE "Company" ADD COLUMN "lastContactAt" DATETIME;

-- Backfill: the later of "emailed by the app" and "contacted in the old tool".
UPDATE "Company" SET "lastContactAt" = CASE
  WHEN "lastEmailedAt" IS NULL THEN "importedLastContactAt"
  WHEN "importedLastContactAt" IS NULL THEN "lastEmailedAt"
  WHEN "lastEmailedAt" > "importedLastContactAt" THEN "lastEmailedAt"
  ELSE "importedLastContactAt"
END;

-- CreateIndex
CREATE INDEX "Company_lastContactAt_idx" ON "Company"("lastContactAt");
