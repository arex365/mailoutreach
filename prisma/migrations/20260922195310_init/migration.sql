-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "passwordHash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "senderDisplayName" TEXT,
    "replyInbox" TEXT,
    "signature" TEXT NOT NULL DEFAULT '',
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "dailyCap" INTEGER,
    "notifyPrefs" JSONB,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SendingDomain" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLiveSendAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SenderAddress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "domainId" INTEGER NOT NULL,
    "localPart" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "mailgunRouteId" TEXT,
    "routeStatus" TEXT,
    "retiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SenderAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SenderAddress_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "SendingDomain" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AccessLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT,
    "userAgent" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "emailNorm" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);

-- CreateTable
CREATE TABLE "SystemState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Secret" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" INTEGER
);

-- CreateTable
CREATE TABLE "Company" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "nameNorm" TEXT NOT NULL,
    "website" TEXT,
    "domain" TEXT,
    "profileKey" TEXT,
    "country" TEXT,
    "timeZone" TEXT,
    "niche" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "priorityRank" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONTACTED',
    "notes" TEXT NOT NULL DEFAULT '',
    "personalLine" TEXT,
    "personalLineSource" TEXT,
    "personalLineUpdatedAt" DATETIME,
    "personalLineUpdatedById" INTEGER,
    "instagram" TEXT,
    "customFields" JSONB,
    "searchText" TEXT NOT NULL DEFAULT '',
    "firstContactedById" INTEGER,
    "firstContactedAt" DATETIME,
    "lastEmailedAt" DATETIME,
    "lastEmailedById" INTEGER,
    "lastEmailedCampaignId" INTEGER,
    "lastEmailedStep" INTEGER,
    "importedLastContactAt" DATETIME,
    "repliedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Company_firstContactedById_fkey" FOREIGN KEY ("firstContactedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Company_lastEmailedById_fkey" FOREIGN KEY ("lastEmailedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Person" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "companyId" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "firstName" TEXT,
    "role" TEXT,
    "email" TEXT,
    "emailNorm" TEXT,
    "isGeneric" BOOLEAN NOT NULL DEFAULT false,
    "verificationStatus" TEXT,
    "verificationRisk" TEXT,
    "verifiedAt" DATETIME,
    "verificationProvider" TEXT,
    "personalLineOverride" TEXT,
    "unsubscribedAt" DATETIME,
    "bouncedAt" DATETIME,
    "complainedAt" DATETIME,
    "repliedAt" DATETIME,
    "lastEmailedAt" DATETIME,
    "lastEmailedById" INTEGER,
    "lastEmailedCampaignId" INTEGER,
    "lastEmailedStep" INTEGER,
    "notes" TEXT NOT NULL DEFAULT '',
    "customFields" JSONB,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Person_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Person_lastEmailedById_fkey" FOREIGN KEY ("lastEmailedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "List" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "List_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyList" (
    "companyId" INTEGER NOT NULL,
    "listId" INTEGER NOT NULL,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById" INTEGER,

    PRIMARY KEY ("companyId", "listId"),
    CONSTRAINT "CompanyList_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CompanyList_listId_fkey" FOREIGN KEY ("listId") REFERENCES "List" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "CompanyTag" (
    "companyId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,

    PRIMARY KEY ("companyId", "tagId"),
    CONSTRAINT "CompanyTag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CompanyTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomField" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "emailNorm" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pushedToMailgunAt" DATETIME
);

-- CreateTable
CREATE TABLE "VerificationCheck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "personId" INTEGER,
    "emailNorm" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "reasons" JSONB,
    "raw" JSONB,
    "costUsd" REAL,
    "jobId" INTEGER,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Template" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "updatedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TemplateStep" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "templateId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TemplateStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "wizardStep" INTEGER NOT NULL DEFAULT 1,
    "mode" TEXT,
    "senderId" INTEGER,
    "fromName" TEXT,
    "fromAddress" TEXT,
    "sendingDomainId" INTEGER,
    "ignoreWindow" BOOLEAN NOT NULL DEFAULT false,
    "daysAsMinutes" BOOLEAN NOT NULL DEFAULT false,
    "sourceTemplateId" INTEGER,
    "audience" JSONB,
    "createdById" INTEGER NOT NULL,
    "startAt" DATETIME,
    "launchedAt" DATETIME,
    "finishedAt" DATETIME,
    "pausedAt" DATETIME,
    "pauseReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Campaign_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Campaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignStep" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CampaignStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "companyId" INTEGER NOT NULL,
    "personId" INTEGER NOT NULL,
    "emailNorm" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "exclusionReason" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "stopReason" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "nextDueAt" DATETIME,
    "hasEdits" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignRecipient_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipientEdit" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "recipientId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "editedById" INTEGER,
    "editedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipientEdit_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompanyReservation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "companyId" INTEGER NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "reservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    "expiresAt" DATETIME,
    CONSTRAINT "CompanyReservation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CompanyReservation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutboundEmail" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "campaignId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "personId" INTEGER,
    "companyId" INTEGER,
    "senderId" INTEGER,
    "step" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toNorm" TEXT NOT NULL,
    "companyDomain" TEXT,
    "companyName" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "claimedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" DATETIME,
    "providerId" TEXT,
    "deliveredAt" DATETIME,
    "tempFailedAt" DATETIME,
    "bouncedAt" DATETIME,
    "complainedAt" DATETIME,
    "unsubscribedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutboundEmail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundEmail_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "CampaignRecipient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundEmail_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TestSend" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "recipientId" INTEGER,
    "providerId" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExternalSend" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "toNorm" TEXT NOT NULL,
    "companyDomain" TEXT,
    "companyId" INTEGER,
    "sentAt" DATETIME NOT NULL,
    "providerMessageId" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MailEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dedupeKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT,
    "reason" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "messageId" TEXT,
    "recipient" TEXT,
    "outboundEmailId" INTEGER,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "stopAppliedAt" DATETIME,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebhookToken" (
    "token" TEXT NOT NULL PRIMARY KEY,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "storageKey" TEXT,
    "messageIdHeader" TEXT,
    "receivedAt" DATETIME NOT NULL,
    "toAddress" TEXT NOT NULL,
    "senderAddressId" INTEGER,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "snippet" TEXT NOT NULL DEFAULT '',
    "inReplyTo" TEXT,
    "references" TEXT,
    "headers" JSONB,
    "kind" TEXT,
    "autoReason" TEXT,
    "outboundEmailId" INTEGER,
    "personId" INTEGER,
    "companyId" INTEGER,
    "campaignId" INTEGER,
    "answeredAt" DATETIME,
    "answeredById" INTEGER,
    "confirmedAt" DATETIME,
    "confirmedById" INTEGER,
    "source" TEXT NOT NULL,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" INTEGER,
    "companyId" INTEGER,
    "personId" INTEGER,
    "campaignId" INTEGER,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" JSONB,
    "mode" TEXT,
    CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lockedAt" DATETIME,
    "lockedBy" TEXT,
    "activeDedupeKey" TEXT,
    "progressDone" INTEGER NOT NULL DEFAULT 0,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" TEXT,
    "createdById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WorkerLease" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workerId" TEXT NOT NULL,
    "heartbeatAt" DATETIME NOT NULL,
    "startedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncCursor" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fileName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sizeBytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "copiedTo" TEXT
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "companyId" INTEGER NOT NULL,
    "jobId" INTEGER,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "line" TEXT,
    "evidenceQuote" TEXT,
    "evidenceSource" TEXT,
    "evidenceUrl" TEXT,
    "flags" JSONB,
    "reasonIfNull" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" REAL,
    "requestId" TEXT,
    "reviewedById" INTEGER,
    "reviewedAt" DATETIME,
    "finalLine" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebsiteSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "companyId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "finalUrl" TEXT,
    "pageKind" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "text" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "lang" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "skipReason" TEXT
);

-- CreateTable
CREATE TABLE "RobotsCache" (
    "host" TEXT NOT NULL PRIMARY KEY,
    "status" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ImportSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdById" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "sheetNames" JSONB,
    "sheet" TEXT,
    "headers" JSONB NOT NULL,
    "mapping" JSONB,
    "options" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "jobId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" DATETIME,
    CONSTRAINT "ImportSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" INTEGER NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "companyId" INTEGER,
    "personId" INTEGER,
    CONSTRAINT "ImportRow_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ImportSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SendingDomain_name_key" ON "SendingDomain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SenderAddress_address_key" ON "SenderAddress"("address");

-- CreateIndex
CREATE INDEX "SenderAddress_userId_idx" ON "SenderAddress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SenderAddress_domainId_localPart_key" ON "SenderAddress"("domainId", "localPart");

-- CreateIndex
CREATE UNIQUE INDEX "AccessLink_tokenHash_key" ON "AccessLink"("tokenHash");

-- CreateIndex
CREATE INDEX "AccessLink_userId_idx" ON "AccessLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "LoginAttempt_emailNorm_at_idx" ON "LoginAttempt"("emailNorm", "at");

-- CreateIndex
CREATE INDEX "LoginAttempt_sourceKey_at_idx" ON "LoginAttempt"("sourceKey", "at");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE INDEX "Company_domain_idx" ON "Company"("domain");

-- CreateIndex
CREATE INDEX "Company_profileKey_idx" ON "Company"("profileKey");

-- CreateIndex
CREATE INDEX "Company_lastEmailedAt_idx" ON "Company"("lastEmailedAt");

-- CreateIndex
CREATE INDEX "Company_country_idx" ON "Company"("country");

-- CreateIndex
CREATE INDEX "Company_nameNorm_idx" ON "Company"("nameNorm");

-- CreateIndex
CREATE INDEX "Company_deletedAt_idx" ON "Company"("deletedAt");

-- CreateIndex
CREATE INDEX "Company_priorityRank_idx" ON "Company"("priorityRank");

-- CreateIndex
CREATE INDEX "Company_niche_idx" ON "Company"("niche");

-- CreateIndex
CREATE INDEX "Company_createdAt_idx" ON "Company"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Person_emailNorm_key" ON "Person"("emailNorm");

-- CreateIndex
CREATE INDEX "Person_companyId_idx" ON "Person"("companyId");

-- CreateIndex
CREATE INDEX "Person_deletedAt_idx" ON "Person"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "List_name_key" ON "List"("name");

-- CreateIndex
CREATE INDEX "CompanyList_listId_companyId_idx" ON "CompanyList"("listId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "CompanyTag_tagId_idx" ON "CompanyTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_key_key" ON "CustomField"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_emailNorm_key" ON "Suppression"("emailNorm");

-- CreateIndex
CREATE INDEX "VerificationCheck_emailNorm_checkedAt_idx" ON "VerificationCheck"("emailNorm", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateStep_templateId_step_key" ON "TemplateStep"("templateId", "step");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_campaignId_step_key" ON "CampaignStep"("campaignId", "step");

-- CreateIndex
CREATE INDEX "CampaignRecipient_companyId_state_idx" ON "CampaignRecipient"("companyId", "state");

-- CreateIndex
CREATE INDEX "CampaignRecipient_state_nextDueAt_idx" ON "CampaignRecipient"("state", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_personId_key" ON "CampaignRecipient"("campaignId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_emailNorm_key" ON "CampaignRecipient"("campaignId", "emailNorm");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientEdit_recipientId_step_key" ON "RecipientEdit"("recipientId", "step");

-- CreateIndex
CREATE INDEX "CompanyReservation_companyId_releasedAt_idx" ON "CompanyReservation"("companyId", "releasedAt");

-- CreateIndex
CREATE INDEX "CompanyReservation_campaignId_idx" ON "CompanyReservation"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_messageId_key" ON "OutboundEmail"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_sendId_key" ON "OutboundEmail"("sendId");

-- CreateIndex
CREATE INDEX "OutboundEmail_status_dueAt_idx" ON "OutboundEmail"("status", "dueAt");

-- CreateIndex
CREATE INDEX "OutboundEmail_companyId_sentAt_idx" ON "OutboundEmail"("companyId", "sentAt");

-- CreateIndex
CREATE INDEX "OutboundEmail_toNorm_sentAt_idx" ON "OutboundEmail"("toNorm", "sentAt");

-- CreateIndex
CREATE INDEX "OutboundEmail_companyDomain_sentAt_idx" ON "OutboundEmail"("companyDomain", "sentAt");

-- CreateIndex
CREATE INDEX "OutboundEmail_campaignId_step_status_idx" ON "OutboundEmail"("campaignId", "step", "status");

-- CreateIndex
CREATE INDEX "OutboundEmail_sentAt_idx" ON "OutboundEmail"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_campaignId_step_toNorm_key" ON "OutboundEmail"("campaignId", "step", "toNorm");

-- CreateIndex
CREATE INDEX "TestSend_userId_sentAt_idx" ON "TestSend"("userId", "sentAt");

-- CreateIndex
CREATE INDEX "ExternalSend_toNorm_sentAt_idx" ON "ExternalSend"("toNorm", "sentAt");

-- CreateIndex
CREATE INDEX "ExternalSend_companyDomain_sentAt_idx" ON "ExternalSend"("companyDomain", "sentAt");

-- CreateIndex
CREATE INDEX "ExternalSend_companyId_sentAt_idx" ON "ExternalSend"("companyId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "MailEvent_dedupeKey_key" ON "MailEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "MailEvent_processedAt_idx" ON "MailEvent"("processedAt");

-- CreateIndex
CREATE INDEX "MailEvent_messageId_idx" ON "MailEvent"("messageId");

-- CreateIndex
CREATE INDEX "MailEvent_recipient_idx" ON "MailEvent"("recipient");

-- CreateIndex
CREATE INDEX "WebhookToken_receivedAt_idx" ON "WebhookToken"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_storageKey_key" ON "InboundMessage"("storageKey");

-- CreateIndex
CREATE INDEX "InboundMessage_processedAt_idx" ON "InboundMessage"("processedAt");

-- CreateIndex
CREATE INDEX "InboundMessage_companyId_idx" ON "InboundMessage"("companyId");

-- CreateIndex
CREATE INDEX "InboundMessage_fromEmail_idx" ON "InboundMessage"("fromEmail");

-- CreateIndex
CREATE INDEX "InboundMessage_messageIdHeader_idx" ON "InboundMessage"("messageIdHeader");

-- CreateIndex
CREATE INDEX "ActivityLog_companyId_at_idx" ON "ActivityLog"("companyId", "at");

-- CreateIndex
CREATE INDEX "ActivityLog_personId_at_idx" ON "ActivityLog"("personId", "at");

-- CreateIndex
CREATE INDEX "ActivityLog_at_idx" ON "ActivityLog"("at");

-- CreateIndex
CREATE INDEX "ActivityLog_actorId_at_idx" ON "ActivityLog"("actorId", "at");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_activeDedupeKey_key" ON "Job"("activeDedupeKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_priority_idx" ON "Job"("status", "runAt", "priority");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Backup_fileName_key" ON "Backup"("fileName");

-- CreateIndex
CREATE INDEX "AiDraft_status_idx" ON "AiDraft"("status");

-- CreateIndex
CREATE INDEX "AiDraft_companyId_idx" ON "AiDraft"("companyId");

-- CreateIndex
CREATE INDEX "WebsiteSnapshot_companyId_fetchedAt_idx" ON "WebsiteSnapshot"("companyId", "fetchedAt");

-- CreateIndex
CREATE INDEX "ImportRow_sessionId_status_idx" ON "ImportRow"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_sessionId_rowNumber_key" ON "ImportRow"("sessionId", "rowNumber");
