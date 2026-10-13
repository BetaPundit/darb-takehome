-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ClientSender" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    CONSTRAINT "ClientSender_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "driverPhone" TEXT,
    "merchantName" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "occurredAt" DATETIME NOT NULL,
    "cardLast4" TEXT,
    CONSTRAINT "Transaction_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "attachmentIndex" INTEGER NOT NULL DEFAULT 0,
    "scopeKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "senderRef" TEXT NOT NULL,
    "clientId" TEXT,
    "blobKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "extraction" JSONB,
    "extractionConfidence" REAL,
    "matchReason" TEXT,
    "failureReason" TEXT,
    "processingStartedAt" DATETIME,
    "duplicateOfId" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Document_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DocumentMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "rank" INTEGER NOT NULL,
    "signals" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    CONSTRAINT "DocumentMatch_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DocumentMatch_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientSender_email_key" ON "ClientSender"("email");

-- CreateIndex
CREATE INDEX "ClientSender_clientId_idx" ON "ClientSender"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_externalRef_key" ON "Transaction"("externalRef");

-- CreateIndex
CREATE INDEX "Transaction_clientId_occurredAt_idx" ON "Transaction"("clientId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_driverPhone_occurredAt_idx" ON "Transaction"("driverPhone", "occurredAt");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_clientId_status_idx" ON "Document"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Document_source_externalMessageId_attachmentIndex_key" ON "Document"("source", "externalMessageId", "attachmentIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Document_scopeKey_contentHash_key" ON "Document"("scopeKey", "contentHash");

-- CreateIndex
CREATE INDEX "DocumentMatch_transactionId_status_idx" ON "DocumentMatch"("transactionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentMatch_documentId_transactionId_key" ON "DocumentMatch"("documentId", "transactionId");

-- Hand-written (Prisma cannot express partial indexes): at most one confirmed match per transaction.
-- This is the concurrency guarantee behind auto-confirm and reviewer confirm; app code catches the violation.
-- Enum values are TEXT on SQLite, hence the literals. On Postgres keep the same statement (see enum cast note in report).
CREATE UNIQUE INDEX "one_confirmed_per_txn" ON "DocumentMatch"("transactionId") WHERE "status" IN ('AUTO_CONFIRMED', 'CONFIRMED');
