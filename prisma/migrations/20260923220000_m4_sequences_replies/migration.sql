-- Milestone 4 (sequences and replies): new nullable/defaulted columns and three indexes. Safe on existing data.
-- InboundKind gains TEST_REPLY: SQLite stores enums as TEXT, so no statement is needed for it.

-- AlterTable
ALTER TABLE "CampaignRecipient" ADD COLUMN "holdReason" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "heldAt" DATETIME;
ALTER TABLE "CampaignRecipient" ADD COLUMN "stoppedByInboundId" INTEGER;

-- AlterTable
ALTER TABLE "InboundMessage" ADD COLUMN "envelopeSender" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "strippedText" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "bodyText" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "bodyAvailable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "InboundMessage" ADD COLUMN "signals" JSONB;
ALTER TABLE "InboundMessage" ADD COLUMN "linkMethod" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "replyScope" TEXT;
ALTER TABLE "InboundMessage" ADD COLUMN "changesStatus" BOOLEAN;
ALTER TABLE "InboundMessage" ADD COLUMN "heldCompanyId" INTEGER;
ALTER TABLE "InboundMessage" ADD COLUMN "assigneeId" INTEGER;
ALTER TABLE "InboundMessage" ADD COLUMN "answerOutcome" TEXT;

-- CreateIndex: the waiting list per person.
CREATE INDEX "InboundMessage_assigneeId_answeredAt_idx" ON "InboundMessage"("assigneeId", "answeredAt");

-- CreateIndex: the Owner's "Everyone's" waiting list.
CREATE INDEX "InboundMessage_kind_answeredAt_idx" ON "InboundMessage"("kind", "answeredAt");

-- CreateIndex: the campaign page's "Replied" count.
CREATE INDEX "InboundMessage_campaignId_kind_idx" ON "InboundMessage"("campaignId", "kind");

-- Data: replies the M3 catch-up recovered from Mailgun's log only (no text) have no body to classify.
UPDATE "InboundMessage" SET "bodyAvailable" = false WHERE "source" = 'CATCHUP' AND "snippet" = '' AND "processedAt" IS NULL;
