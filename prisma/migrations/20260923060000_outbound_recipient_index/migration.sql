-- CreateIndex: lets the follow-up sweeper, the campaign page and the recipient panel find a person's emails without scanning every email.
CREATE INDEX "OutboundEmail_recipientId_step_idx" ON "OutboundEmail"("recipientId", "step");
