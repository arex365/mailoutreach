-- Milestone 3 (Mailgun): new nullable/defaulted columns and four indexes. Safe on existing data.

-- AlterTable
ALTER TABLE "SendingDomain" ADD COLUMN "catchAllRouteId" TEXT;
ALTER TABLE "SendingDomain" ADD COLUMN "dmarcRouteId" TEXT;

-- AlterTable
ALTER TABLE "SenderAddress" ADD COLUMN "forwardTo" TEXT;
ALTER TABLE "SenderAddress" ADD COLUMN "routeCheckedAt" DATETIME;
ALTER TABLE "SenderAddress" ADD COLUMN "routeError" TEXT;

-- AlterTable
ALTER TABLE "TestSend" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'SELF';
ALTER TABLE "TestSend" ADD COLUMN "messageId" TEXT;
ALTER TABLE "TestSend" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'SENT';
ALTER TABLE "TestSend" ADD COLUMN "error" TEXT;

-- AlterTable
ALTER TABLE "MailEvent" ADD COLUMN "testSendId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "TestSend_messageId_key" ON "TestSend"("messageId");

-- CreateIndex: lets the health check count bounces for a window of emails without scanning every event.
CREATE INDEX "MailEvent_outboundEmailId_idx" ON "MailEvent"("outboundEmailId");

-- CreateIndex: reply-test facts and "Send me a test" events.
CREATE INDEX "MailEvent_testSendId_idx" ON "MailEvent"("testSendId");

-- CreateIndex: events that carry Mailgun's id instead of ours.
CREATE INDEX "OutboundEmail_providerId_idx" ON "OutboundEmail"("providerId");

-- Data: dry runs launched before M3 keep ignoring sending hours (M2 behaviour; the switch now means "gated when off").
UPDATE "Campaign" SET "ignoreWindow" = true WHERE "mode" = 'DRY_RUN';
