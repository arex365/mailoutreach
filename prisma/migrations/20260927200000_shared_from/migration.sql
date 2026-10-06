-- Shared From address (SHARED-FROM-DESIGN §2.3, F7, F26): the Reply-To each campaign and email was sent with, and the
-- shared From address each test email showed. Null = per-person mode, which every existing row is. Nothing to backfill.

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "replyTo" TEXT;

-- AlterTable
ALTER TABLE "OutboundEmail" ADD COLUMN "replyTo" TEXT;

-- AlterTable
ALTER TABLE "TestSend" ADD COLUMN "teamFrom" TEXT;
