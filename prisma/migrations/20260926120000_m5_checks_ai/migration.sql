-- Milestone 5 (address checks and AI): new nullable/defaulted columns (27) and seven indexes. Safe on existing data.

-- AlterTable
ALTER TABLE "Person" ADD COLUMN "verificationDisposable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Person" ADD COLUMN "verificationUnknowns" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VerificationCheck" ADD COLUMN "isRole" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VerificationCheck" ADD COLUMN "isDisposable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VerificationCheck" ADD COLUMN "didYouMean" TEXT;
ALTER TABLE "VerificationCheck" ADD COLUMN "source" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "launchedGoLive" BOOLEAN;

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN "recheckAt" DATETIME;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "cancelRequestedAt" DATETIME;

-- AlterTable
ALTER TABLE "AiDraft" ADD COLUMN "createdById" INTEGER;
ALTER TABLE "AiDraft" ADD COLUMN "readAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiDraft" ADD COLUMN "calls" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiDraft" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "AiDraft" ADD COLUMN "draftedAt" DATETIME;
ALTER TABLE "AiDraft" ADD COLUMN "homeSnapshotId" INTEGER;
ALTER TABLE "AiDraft" ADD COLUMN "pageSnapshotId" INTEGER;
ALTER TABLE "AiDraft" ADD COLUMN "avoidLines" JSONB;
ALTER TABLE "AiDraft" ADD COLUMN "refetch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiDraft" ADD COLUMN "reviewAction" TEXT;
ALTER TABLE "AiDraft" ADD COLUMN "prevLine" TEXT;
ALTER TABLE "AiDraft" ADD COLUMN "prevLineSource" TEXT;
ALTER TABLE "AiDraft" ADD COLUMN "prevLineUpdatedAt" DATETIME;
ALTER TABLE "AiDraft" ADD COLUMN "prevLineUpdatedById" INTEGER;

-- AlterTable
ALTER TABLE "WebsiteSnapshot" ADD COLUMN "title" TEXT;
ALTER TABLE "WebsiteSnapshot" ADD COLUMN "contentType" TEXT;
ALTER TABLE "WebsiteSnapshot" ADD COLUMN "bytes" INTEGER;
ALTER TABLE "WebsiteSnapshot" ADD COLUMN "notes" JSONB;

-- CreateIndex: a person's check history (the panel's reasons and "Did you mean").
CREATE INDEX "VerificationCheck_personId_checkedAt_idx" ON "VerificationCheck"("personId", "checkedAt");
-- CreateIndex: a run's results (the Verify step, the run summary, resume "never pays twice").
CREATE INDEX "VerificationCheck_jobId_idx" ON "VerificationCheck"("jobId");
-- CreateIndex: checks this month.
CREATE INDEX "VerificationCheck_checkedAt_idx" ON "VerificationCheck"("checkedAt");
-- CreateIndex: the re-check sweep.
CREATE INDEX "CampaignRecipient_state_recheckAt_idx" ON "CampaignRecipient"("state", "recheckAt");
-- CreateIndex: the review queue tabs.
CREATE INDEX "AiDraft_status_createdAt_idx" ON "AiDraft"("status", "createdAt");
-- CreateIndex: AI spend this month.
CREATE INDEX "AiDraft_draftedAt_idx" ON "AiDraft"("draftedAt");
-- CreateIndex: a run's drafts.
CREATE INDEX "AiDraft_jobId_idx" ON "AiDraft"("jobId");

-- Data: an "unknown" result stored before M5 (demo data) counts as one unknown in a row.
UPDATE "Person" SET "verificationUnknowns" = 1 WHERE "verificationStatus" = 'UNKNOWN';
