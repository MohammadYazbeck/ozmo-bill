-- Keep the initial schema all-or-nothing. PostgreSQL migrations are not
-- automatically wrapped in a transaction by Prisma Migrate.
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CurrencyCode" AS ENUM ('USD', 'SYP');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceLineType" AS ENUM ('SUBSCRIPTION', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CashDirection" AS ENUM ('INFLOW', 'OUTFLOW');

-- CreateEnum
CREATE TYPE "CashEntryStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "LiabilityPartyType" AS ENUM ('PHOTOGRAPHER', 'MODEL', 'SUPPLIER', 'FREELANCER', 'OTHER');

-- CreateEnum
CREATE TYPE "LiabilityStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "PayrollItemStatus" AS ENUM ('READY', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "AdvanceRecipientType" AS ENUM ('EMPLOYEE', 'OWNER_PARTNER');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('OPEN', 'PARTIALLY_REPAID', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('DUE', 'PARTIALLY_PAID', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "ServiceSubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE', 'RECEIPT');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'ARCHIVE', 'POST', 'REVERSE', 'VOID', 'LOGIN');

-- CreateEnum
CREATE TYPE "CashEntryKind" AS ENUM ('SUBSCRIPTION_PAYMENT', 'CLIENT_EXTRA_INCOME', 'ADVERTISING_INCOME', 'EXTERNAL_INCOME', 'MANUAL_EXPENSE', 'LIABILITY_PAYMENT', 'RECURRING_EXPENSE_PAYMENT', 'SERVICE_PAYMENT', 'PAYROLL_PAYMENT', 'ADVANCE_DISBURSEMENT', 'ADVANCE_REPAYMENT', 'OPENING_BALANCE', 'REVERSAL');

-- CreateEnum
CREATE TYPE "CashApplicationKind" AS ENUM ('CUSTOMER_PAYMENT', 'LIABILITY_PAYMENT', 'PAYROLL_PAYMENT', 'ADVANCE_DISBURSEMENT', 'ADVANCE_REPAYMENT', 'RECURRING_EXPENSE_PAYMENT', 'SERVICE_PAYMENT');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "timezone" VARCHAR(100) NOT NULL DEFAULT 'Asia/Damascus',
    "reportingCurrency" "CurrencyCode" NOT NULL DEFAULT 'USD',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "organizationId" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("organizationId","key")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "baseCurrency" "CurrencyCode" NOT NULL DEFAULT 'USD',
    "quoteCurrency" "CurrencyCode" NOT NULL DEFAULT 'SYP',
    "rate" DECIMAL(20,8) NOT NULL,
    "effectiveAt" DATE NOT NULL,
    "source" VARCHAR(120),
    "note" TEXT,
    "createdBy" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(50),
    "email" VARCHAR(320),
    "note" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "dueDay" INTEGER NOT NULL DEFAULT 1,
    "nextInvoiceDate" DATE,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionRate" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "packageName" VARCHAR(200) NOT NULL,
    "monthlyAmountUsd" DECIMAL(20,4) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SubscriptionRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "number" VARCHAR(50) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotalUsd" DECIMAL(20,4) NOT NULL,
    "totalUsd" DECIMAL(20,4) NOT NULL,
    "openingBalanceSnapshotUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMPTZ(3),
    "voidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "InvoiceLineType" NOT NULL DEFAULT 'SUBSCRIPTION',
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL DEFAULT 1,
    "unitAmountUsd" DECIMAL(20,4) NOT NULL,
    "lineTotalUsd" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID,
    "expenseCategoryId" UUID,
    "direction" "CashDirection" NOT NULL,
    "kind" "CashEntryKind" NOT NULL,
    "status" "CashEntryStatus" NOT NULL DEFAULT 'POSTED',
    "occurredOn" DATE NOT NULL,
    "amountOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "currencyUnitsPerUsd" DECIMAL(20,8) NOT NULL,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "description" VARCHAR(250) NOT NULL,
    "note" TEXT,
    "externalReference" VARCHAR(120),
    "reversalOfId" UUID,
    "createdBy" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashEntryApplication" (
    "cashEntryId" UUID NOT NULL,
    "applicationKind" "CashApplicationKind" NOT NULL,
    "applicationId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashEntryApplication_pkey" PRIMARY KEY ("cashEntryId")
);

-- CreateTable
CREATE TABLE "CustomerPayment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "cashEntryId" UUID NOT NULL,
    "receiptNumber" VARCHAR(50) NOT NULL,
    "receivedOn" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liability" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" UUID,
    "expenseCategoryId" UUID,
    "payeeName" VARCHAR(200) NOT NULL,
    "partyType" "LiabilityPartyType" NOT NULL DEFAULT 'OTHER',
    "incurredOn" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "amountOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "currencyUnitsPerUsd" DECIMAL(20,8) NOT NULL,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "status" "LiabilityStatus" NOT NULL DEFAULT 'OPEN',
    "voidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Liability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiabilityPayment" (
    "id" UUID NOT NULL,
    "liabilityId" UUID NOT NULL,
    "cashEntryId" UUID NOT NULL,
    "appliedAmountUsd" DECIMAL(20,4) NOT NULL,
    "paidOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiabilityPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phone" VARCHAR(50),
    "title" VARCHAR(150),
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "hireDate" DATE,
    "endDate" DATE,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeCompensation" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "baseSalaryUsd" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeCompensation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(3),
    "voidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "baseSalaryUsd" DECIMAL(20,4) NOT NULL,
    "bonusUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "otherEarningsUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "deductionUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "advanceDeductionUsd" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "grossEarningsUsd" DECIMAL(20,4) NOT NULL,
    "deductionTotalUsd" DECIMAL(20,4) NOT NULL,
    "netPayUsd" DECIMAL(20,4) NOT NULL,
    "status" "PayrollItemStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPayment" (
    "id" UUID NOT NULL,
    "payrollItemId" UUID NOT NULL,
    "cashEntryId" UUID NOT NULL,
    "appliedAmountUsd" DECIMAL(20,4) NOT NULL,
    "paidOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "employeeId" UUID,
    "cashEntryId" UUID NOT NULL,
    "recipientType" "AdvanceRecipientType" NOT NULL,
    "recipientName" VARCHAR(200) NOT NULL,
    "disbursedOn" DATE NOT NULL,
    "principalOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "currencyUnitsPerUsd" DECIMAL(20,8) NOT NULL,
    "principalUsd" DECIMAL(20,4) NOT NULL,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Advance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceRepayment" (
    "id" UUID NOT NULL,
    "advanceId" UUID NOT NULL,
    "cashEntryId" UUID,
    "payrollItemId" UUID,
    "amountUsd" DECIMAL(20,4) NOT NULL,
    "repaidOn" DATE NOT NULL,
    "reversedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpenseTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "amountOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "dueDay" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecurringExpenseTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpenseOccurrence" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "periodStart" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "expectedOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "currencyUnitsPerUsd" DECIMAL(20,8) NOT NULL,
    "expectedUsd" DECIMAL(20,4) NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'DUE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecurringExpenseOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringExpensePayment" (
    "id" UUID NOT NULL,
    "occurrenceId" UUID NOT NULL,
    "cashEntryId" UUID NOT NULL,
    "appliedAmountUsd" DECIMAL(20,4) NOT NULL,
    "paidOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringExpensePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceSubscription" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "provider" VARCHAR(200),
    "amountOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "billingAnchorDay" INTEGER NOT NULL DEFAULT 1,
    "nextRenewalDate" DATE,
    "status" "ServiceSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "note" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCharge" (
    "id" UUID NOT NULL,
    "serviceSubscriptionId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE,
    "dueDate" DATE NOT NULL,
    "expectedOriginal" DECIMAL(20,4) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "currencyUnitsPerUsd" DECIMAL(20,8) NOT NULL,
    "expectedUsd" DECIMAL(20,4) NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'DUE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ServiceCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePayment" (
    "id" UUID NOT NULL,
    "serviceChargeId" UUID NOT NULL,
    "cashEntryId" UUID NOT NULL,
    "appliedAmountUsd" DECIMAL(20,4) NOT NULL,
    "paidOn" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" "DocumentType" NOT NULL,
    "year" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scope" VARCHAR(100) NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PROCESSING',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "resourceType" VARCHAR(100),
    "resourceId" UUID,
    "errorMessage" TEXT,
    "lockedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actor" VARCHAR(100),
    "action" "AuditAction" NOT NULL,
    "entityType" VARCHAR(100) NOT NULL,
    "entityId" VARCHAR(100) NOT NULL,
    "requestId" UUID,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Organization_archivedAt_idx" ON "Organization"("archivedAt");

-- CreateIndex
CREATE INDEX "ExchangeRate_organizationId_baseCurrency_quoteCurrency_effe_idx" ON "ExchangeRate"("organizationId", "baseCurrency", "quoteCurrency", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_organizationId_baseCurrency_quoteCurrency_effe_key" ON "ExchangeRate"("organizationId", "baseCurrency", "quoteCurrency", "effectiveAt");

-- CreateIndex
CREATE INDEX "Client_organizationId_status_idx" ON "Client"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Client_organizationId_name_idx" ON "Client"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Client_archivedAt_idx" ON "Client"("archivedAt");

-- CreateIndex
CREATE INDEX "Subscription_organizationId_status_nextInvoiceDate_idx" ON "Subscription"("organizationId", "status", "nextInvoiceDate");

-- CreateIndex
CREATE INDEX "Subscription_clientId_status_idx" ON "Subscription"("clientId", "status");

-- CreateIndex
CREATE INDEX "Subscription_archivedAt_idx" ON "Subscription"("archivedAt");

-- CreateIndex
CREATE INDEX "SubscriptionRate_subscriptionId_effectiveTo_idx" ON "SubscriptionRate"("subscriptionId", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionRate_subscriptionId_effectiveFrom_key" ON "SubscriptionRate"("subscriptionId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_dueDate_idx" ON "Invoice"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Invoice_clientId_issueDate_idx" ON "Invoice"("clientId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_number_key" ON "Invoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_subscriptionId_periodStart_key" ON "Invoice"("subscriptionId", "periodStart");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");

-- CreateIndex
CREATE INDEX "ExpenseCategory_organizationId_isActive_idx" ON "ExpenseCategory"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_organizationId_slug_key" ON "ExpenseCategory"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntry_reversalOfId_key" ON "CashEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "CashEntry_organizationId_occurredOn_idx" ON "CashEntry"("organizationId", "occurredOn");

-- CreateIndex
CREATE INDEX "CashEntry_organizationId_direction_occurredOn_idx" ON "CashEntry"("organizationId", "direction", "occurredOn");

-- CreateIndex
CREATE INDEX "CashEntry_clientId_occurredOn_idx" ON "CashEntry"("clientId", "occurredOn");

-- CreateIndex
CREATE INDEX "CashEntry_expenseCategoryId_occurredOn_idx" ON "CashEntry"("expenseCategoryId", "occurredOn");

-- CreateIndex
CREATE INDEX "CashEntry_status_idx" ON "CashEntry"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CashEntryApplication_applicationKind_applicationId_key" ON "CashEntryApplication"("applicationKind", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_cashEntryId_key" ON "CustomerPayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "CustomerPayment_clientId_receivedOn_idx" ON "CustomerPayment"("clientId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPayment_organizationId_receiptNumber_key" ON "CustomerPayment"("organizationId", "receiptNumber");

-- CreateIndex
CREATE INDEX "PaymentAllocation_invoiceId_idx" ON "PaymentAllocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentId_invoiceId_key" ON "PaymentAllocation"("paymentId", "invoiceId");

-- CreateIndex
CREATE INDEX "Liability_organizationId_status_dueDate_idx" ON "Liability"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "Liability_clientId_status_idx" ON "Liability"("clientId", "status");

-- CreateIndex
CREATE INDEX "Liability_expenseCategoryId_idx" ON "Liability"("expenseCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "LiabilityPayment_cashEntryId_key" ON "LiabilityPayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "LiabilityPayment_liabilityId_paidOn_idx" ON "LiabilityPayment"("liabilityId", "paidOn");

-- CreateIndex
CREATE INDEX "Employee_organizationId_status_idx" ON "Employee"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Employee_organizationId_name_idx" ON "Employee"("organizationId", "name");

-- CreateIndex
CREATE INDEX "EmployeeCompensation_employeeId_effectiveTo_idx" ON "EmployeeCompensation"("employeeId", "effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCompensation_employeeId_effectiveFrom_key" ON "EmployeeCompensation"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayrollRun_organizationId_status_periodStart_idx" ON "PayrollRun"("organizationId", "status", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_organizationId_periodStart_key" ON "PayrollRun"("organizationId", "periodStart");

-- CreateIndex
CREATE INDEX "PayrollItem_employeeId_status_idx" ON "PayrollItem"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_payrollRunId_employeeId_key" ON "PayrollItem"("payrollRunId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPayment_cashEntryId_key" ON "PayrollPayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "PayrollPayment_payrollItemId_paidOn_idx" ON "PayrollPayment"("payrollItemId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "Advance_cashEntryId_key" ON "Advance"("cashEntryId");

-- CreateIndex
CREATE INDEX "Advance_organizationId_status_disbursedOn_idx" ON "Advance"("organizationId", "status", "disbursedOn");

-- CreateIndex
CREATE INDEX "Advance_employeeId_status_idx" ON "Advance"("employeeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRepayment_cashEntryId_key" ON "AdvanceRepayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_advanceId_repaidOn_idx" ON "AdvanceRepayment"("advanceId", "repaidOn");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_payrollItemId_idx" ON "AdvanceRepayment"("payrollItemId");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_payrollItemId_reversedAt_idx" ON "AdvanceRepayment"("payrollItemId", "reversedAt");

-- CreateIndex
CREATE INDEX "AdvanceRepayment_advanceId_payrollItemId_idx" ON "AdvanceRepayment"("advanceId", "payrollItemId");

-- CreateIndex
CREATE INDEX "RecurringExpenseTemplate_organizationId_isActive_idx" ON "RecurringExpenseTemplate"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "RecurringExpenseTemplate_expenseCategoryId_idx" ON "RecurringExpenseTemplate"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "RecurringExpenseOccurrence_status_dueDate_idx" ON "RecurringExpenseOccurrence"("status", "dueDate");

-- CreateIndex
CREATE INDEX "RecurringExpenseOccurrence_expenseCategoryId_idx" ON "RecurringExpenseOccurrence"("expenseCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringExpenseOccurrence_templateId_periodStart_key" ON "RecurringExpenseOccurrence"("templateId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "RecurringExpensePayment_cashEntryId_key" ON "RecurringExpensePayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "RecurringExpensePayment_occurrenceId_paidOn_idx" ON "RecurringExpensePayment"("occurrenceId", "paidOn");

-- CreateIndex
CREATE INDEX "ServiceSubscription_organizationId_status_nextRenewalDate_idx" ON "ServiceSubscription"("organizationId", "status", "nextRenewalDate");

-- CreateIndex
CREATE INDEX "ServiceSubscription_expenseCategoryId_idx" ON "ServiceSubscription"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "ServiceCharge_status_dueDate_idx" ON "ServiceCharge"("status", "dueDate");

-- CreateIndex
CREATE INDEX "ServiceCharge_expenseCategoryId_idx" ON "ServiceCharge"("expenseCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCharge_serviceSubscriptionId_dueDate_key" ON "ServiceCharge"("serviceSubscriptionId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePayment_cashEntryId_key" ON "ServicePayment"("cashEntryId");

-- CreateIndex
CREATE INDEX "ServicePayment_serviceChargeId_paidOn_idx" ON "ServicePayment"("serviceChargeId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_organizationId_type_year_key" ON "DocumentSequence"("organizationId", "type", "year");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_organizationId_status_expiresAt_idx" ON "IdempotencyRecord"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_organizationId_scope_key_key" ON "IdempotencyRecord"("organizationId", "scope", "key");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_entityType_entityId_occurredAt_idx" ON "AuditEvent"("organizationId", "entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_actor_occurredAt_idx" ON "AuditEvent"("organizationId", "actor", "occurredAt");

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExchangeRate" ADD CONSTRAINT "ExchangeRate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionRate" ADD CONSTRAINT "SubscriptionRate_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntry" ADD CONSTRAINT "CashEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashEntryApplication" ADD CONSTRAINT "CashEntryApplication_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "CustomerPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liability" ADD CONSTRAINT "Liability_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityPayment" ADD CONSTRAINT "LiabilityPayment_liabilityId_fkey" FOREIGN KEY ("liabilityId") REFERENCES "Liability"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiabilityPayment" ADD CONSTRAINT "LiabilityPayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeCompensation" ADD CONSTRAINT "EmployeeCompensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPayment" ADD CONSTRAINT "PayrollPayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advance" ADD CONSTRAINT "Advance_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "Advance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_payrollItemId_fkey" FOREIGN KEY ("payrollItemId") REFERENCES "PayrollItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpenseTemplate" ADD CONSTRAINT "RecurringExpenseTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpenseTemplate" ADD CONSTRAINT "RecurringExpenseTemplate_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpenseOccurrence" ADD CONSTRAINT "RecurringExpenseOccurrence_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RecurringExpenseTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpenseOccurrence" ADD CONSTRAINT "RecurringExpenseOccurrence_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpensePayment" ADD CONSTRAINT "RecurringExpensePayment_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "RecurringExpenseOccurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringExpensePayment" ADD CONSTRAINT "RecurringExpensePayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSubscription" ADD CONSTRAINT "ServiceSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSubscription" ADD CONSTRAINT "ServiceSubscription_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCharge" ADD CONSTRAINT "ServiceCharge_serviceSubscriptionId_fkey" FOREIGN KEY ("serviceSubscriptionId") REFERENCES "ServiceSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCharge" ADD CONSTRAINT "ServiceCharge_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayment" ADD CONSTRAINT "ServicePayment_serviceChargeId_fkey" FOREIGN KEY ("serviceChargeId") REFERENCES "ServiceCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePayment" ADD CONSTRAINT "ServicePayment_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "CashEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain integrity checks Prisma cannot express in the schema.
ALTER TABLE "ExchangeRate"
  ADD CONSTRAINT "ExchangeRate_rate_positive" CHECK ("rate" > 0),
  ADD CONSTRAINT "ExchangeRate_currency_pair_distinct" CHECK ("baseCurrency" <> "quoteCurrency");

ALTER TABLE "Subscription"
  ADD CONSTRAINT "Subscription_dueDay_range" CHECK ("dueDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "Subscription_date_range" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "SubscriptionRate"
  ADD CONSTRAINT "SubscriptionRate_amount_positive" CHECK ("monthlyAmountUsd" > 0),
  ADD CONSTRAINT "SubscriptionRate_date_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom");

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_period_range" CHECK ("periodEnd" >= "periodStart"),
  ADD CONSTRAINT "Invoice_due_after_issue" CHECK ("dueDate" >= "issueDate"),
  ADD CONSTRAINT "Invoice_amounts_nonnegative" CHECK (
    "subtotalUsd" >= 0 AND "totalUsd" >= 0 AND "openingBalanceSnapshotUsd" >= 0
  );

ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_position_positive" CHECK ("position" > 0),
  ADD CONSTRAINT "InvoiceLine_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "InvoiceLine_amounts_nonnegative" CHECK ("unitAmountUsd" >= 0 AND "lineTotalUsd" >= 0);

ALTER TABLE "CashEntry"
  ADD CONSTRAINT "CashEntry_amounts_positive" CHECK (
    "amountOriginal" > 0 AND "currencyUnitsPerUsd" > 0 AND "amountUsd" > 0
  ),
  ADD CONSTRAINT "CashEntry_conversion_consistent" CHECK (
    ("currency" = 'USD' AND "currencyUnitsPerUsd" = 1 AND "amountUsd" = "amountOriginal")
    OR
    ("currency" = 'SYP' AND abs("amountUsd" - round("amountOriginal" / "currencyUnitsPerUsd", 4)) <= 0.0001)
  ),
  ADD CONSTRAINT "CashEntry_kind_direction_consistent" CHECK (
    "kind" IN ('OPENING_BALANCE', 'REVERSAL')
    OR ("direction" = 'INFLOW' AND "kind" IN (
      'SUBSCRIPTION_PAYMENT', 'CLIENT_EXTRA_INCOME', 'ADVERTISING_INCOME',
      'EXTERNAL_INCOME', 'ADVANCE_REPAYMENT'
    ))
    OR ("direction" = 'OUTFLOW' AND "kind" IN (
      'MANUAL_EXPENSE', 'LIABILITY_PAYMENT', 'RECURRING_EXPENSE_PAYMENT',
      'SERVICE_PAYMENT', 'PAYROLL_PAYMENT', 'ADVANCE_DISBURSEMENT'
    ))
  ),
  ADD CONSTRAINT "CashEntry_reversal_link_consistent" CHECK (
    ("kind" = 'REVERSAL' AND "reversalOfId" IS NOT NULL)
    OR ("kind" <> 'REVERSAL' AND "reversalOfId" IS NULL)
  ),
  ADD CONSTRAINT "CashEntry_client_required" CHECK (
    "kind" NOT IN ('SUBSCRIPTION_PAYMENT', 'CLIENT_EXTRA_INCOME') OR "clientId" IS NOT NULL
  ),
  ADD CONSTRAINT "CashEntry_manual_expense_category_required" CHECK (
    "kind" <> 'MANUAL_EXPENSE' OR "expenseCategoryId" IS NOT NULL
  );

ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_amount_positive" CHECK ("amountUsd" > 0);

ALTER TABLE "Liability"
  ADD CONSTRAINT "Liability_due_after_incurred" CHECK ("dueDate" >= "incurredOn"),
  ADD CONSTRAINT "Liability_amounts_positive" CHECK (
    "amountOriginal" > 0 AND "currencyUnitsPerUsd" > 0 AND "amountUsd" > 0
  ),
  ADD CONSTRAINT "Liability_conversion_consistent" CHECK (
    ("currency" = 'USD' AND "currencyUnitsPerUsd" = 1 AND "amountUsd" = "amountOriginal")
    OR
    ("currency" = 'SYP' AND abs("amountUsd" - round("amountOriginal" / "currencyUnitsPerUsd", 4)) <= 0.0001)
  );

ALTER TABLE "LiabilityPayment"
  ADD CONSTRAINT "LiabilityPayment_amount_positive" CHECK ("appliedAmountUsd" > 0);

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_date_range" CHECK (
    "hireDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "hireDate"
  );

ALTER TABLE "EmployeeCompensation"
  ADD CONSTRAINT "EmployeeCompensation_salary_nonnegative" CHECK ("baseSalaryUsd" >= 0),
  ADD CONSTRAINT "EmployeeCompensation_date_range" CHECK (
    "effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"
  );

ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_period_is_month" CHECK (
    "periodStart" = date_trunc('month', "periodStart")::date
  );

ALTER TABLE "PayrollItem"
  ADD CONSTRAINT "PayrollItem_amounts_nonnegative" CHECK (
    "baseSalaryUsd" >= 0 AND "bonusUsd" >= 0 AND "otherEarningsUsd" >= 0
    AND "deductionUsd" >= 0 AND "advanceDeductionUsd" >= 0
    AND "grossEarningsUsd" >= 0 AND "deductionTotalUsd" >= 0 AND "netPayUsd" >= 0
  ),
  ADD CONSTRAINT "PayrollItem_totals_consistent" CHECK (
    "grossEarningsUsd" = "baseSalaryUsd" + "bonusUsd" + "otherEarningsUsd"
    AND "deductionTotalUsd" = "deductionUsd" + "advanceDeductionUsd"
    AND "netPayUsd" = "grossEarningsUsd" - "deductionTotalUsd"
  );

ALTER TABLE "PayrollPayment"
  ADD CONSTRAINT "PayrollPayment_amount_positive" CHECK ("appliedAmountUsd" > 0);

ALTER TABLE "Advance"
  ADD CONSTRAINT "Advance_amounts_positive" CHECK (
    "principalOriginal" > 0 AND "currencyUnitsPerUsd" > 0 AND "principalUsd" > 0
  ),
  ADD CONSTRAINT "Advance_conversion_consistent" CHECK (
    ("currency" = 'USD' AND "currencyUnitsPerUsd" = 1 AND "principalUsd" = "principalOriginal")
    OR
    ("currency" = 'SYP' AND abs("principalUsd" - round("principalOriginal" / "currencyUnitsPerUsd", 4)) <= 0.0001)
  ),
  ADD CONSTRAINT "Advance_recipient_consistent" CHECK (
    ("recipientType" = 'EMPLOYEE' AND "employeeId" IS NOT NULL)
    OR ("recipientType" = 'OWNER_PARTNER' AND "employeeId" IS NULL)
  );

ALTER TABLE "AdvanceRepayment"
  ADD CONSTRAINT "AdvanceRepayment_amount_positive" CHECK ("amountUsd" > 0),
  ADD CONSTRAINT "AdvanceRepayment_exactly_one_source" CHECK (
    (("cashEntryId" IS NOT NULL)::integer + ("payrollItemId" IS NOT NULL)::integer) = 1
  ),
  ADD CONSTRAINT "AdvanceRepayment_reversal_source" CHECK (
    "reversedAt" IS NULL OR ("payrollItemId" IS NOT NULL AND "cashEntryId" IS NULL)
  );

ALTER TABLE "RecurringExpenseTemplate"
  ADD CONSTRAINT "RecurringExpenseTemplate_amount_positive" CHECK ("amountOriginal" > 0),
  ADD CONSTRAINT "RecurringExpenseTemplate_dueDay_range" CHECK ("dueDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "RecurringExpenseTemplate_date_range" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "RecurringExpenseOccurrence"
  ADD CONSTRAINT "RecurringExpenseOccurrence_period_is_month" CHECK (
    "periodStart" = date_trunc('month', "periodStart")::date
  ),
  ADD CONSTRAINT "RecurringExpenseOccurrence_amounts_positive" CHECK (
    "expectedOriginal" > 0 AND "currencyUnitsPerUsd" > 0 AND "expectedUsd" > 0
  ),
  ADD CONSTRAINT "RecurringExpenseOccurrence_conversion_consistent" CHECK (
    ("currency" = 'USD' AND "currencyUnitsPerUsd" = 1 AND "expectedUsd" = "expectedOriginal")
    OR
    ("currency" = 'SYP' AND abs("expectedUsd" - round("expectedOriginal" / "currencyUnitsPerUsd", 4)) <= 0.0001)
  );

ALTER TABLE "RecurringExpensePayment"
  ADD CONSTRAINT "RecurringExpensePayment_amount_positive" CHECK ("appliedAmountUsd" > 0);

ALTER TABLE "ServiceSubscription"
  ADD CONSTRAINT "ServiceSubscription_amount_positive" CHECK ("amountOriginal" > 0),
  ADD CONSTRAINT "ServiceSubscription_anchor_day_range" CHECK ("billingAnchorDay" BETWEEN 1 AND 31),
  ADD CONSTRAINT "ServiceSubscription_date_range" CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "ServiceCharge"
  ADD CONSTRAINT "ServiceCharge_period_range" CHECK ("periodEnd" IS NULL OR "periodEnd" >= "periodStart"),
  ADD CONSTRAINT "ServiceCharge_amounts_positive" CHECK (
    "expectedOriginal" > 0 AND "currencyUnitsPerUsd" > 0 AND "expectedUsd" > 0
  ),
  ADD CONSTRAINT "ServiceCharge_conversion_consistent" CHECK (
    ("currency" = 'USD' AND "currencyUnitsPerUsd" = 1 AND "expectedUsd" = "expectedOriginal")
    OR
    ("currency" = 'SYP' AND abs("expectedUsd" - round("expectedOriginal" / "currencyUnitsPerUsd", 4)) <= 0.0001)
  );

ALTER TABLE "ServicePayment"
  ADD CONSTRAINT "ServicePayment_amount_positive" CHECK ("appliedAmountUsd" > 0);

ALTER TABLE "DocumentSequence"
  ADD CONSTRAINT "DocumentSequence_year_valid" CHECK ("year" BETWEEN 2000 AND 9999),
  ADD CONSTRAINT "DocumentSequence_nextValue_positive" CHECK ("nextValue" > 0);

ALTER TABLE "IdempotencyRecord"
  ADD CONSTRAINT "IdempotencyRecord_requestHash_sha256" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "IdempotencyRecord_responseStatus_valid" CHECK (
    "responseStatus" IS NULL OR "responseStatus" BETWEEN 100 AND 599
  ),
  ADD CONSTRAINT "IdempotencyRecord_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

-- Every specialized cash entry is claimed by exactly one application family.
-- The registry primary key is the concurrency guard across all seven families;
-- per-table unique indexes alone cannot prevent cross-table reuse.
CREATE FUNCTION "assert_cash_entry_application"(
  application_kind "CashApplicationKind",
  application_id UUID,
  cash_entry_id UUID
) RETURNS void AS $$
DECLARE
  expected_cash_kind "CashEntryKind";
  cash_kind "CashEntryKind";
  cash_status "CashEntryStatus";
  cash_organization_id UUID;
  cash_client_id UUID;
  cash_category_id UUID;
  cash_occurred_on DATE;
  cash_amount_usd DECIMAL(20,4);
  cash_amount_original DECIMAL(20,4);
  cash_currency "CurrencyCode";
  cash_rate DECIMAL(20,8);
  application_organization_id UUID;
  application_client_id UUID;
  application_category_id UUID;
  application_date DATE;
  application_amount_usd DECIMAL(20,4);
  application_amount_original DECIMAL(20,4);
  application_currency "CurrencyCode";
  application_rate DECIMAL(20,8);
  check_client BOOLEAN := false;
  check_category BOOLEAN := false;
  check_amount BOOLEAN := false;
  check_original_conversion BOOLEAN := false;
BEGIN
  SELECT ce."kind", ce."status", ce."organizationId", ce."clientId",
         ce."expenseCategoryId", ce."occurredOn", ce."amountUsd",
         ce."amountOriginal", ce."currency", ce."currencyUnitsPerUsd"
  INTO cash_kind, cash_status, cash_organization_id, cash_client_id,
       cash_category_id, cash_occurred_on, cash_amount_usd,
       cash_amount_original, cash_currency, cash_rate
  FROM public."CashEntry" ce
  WHERE ce."id" = cash_entry_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'CashEntryApplication_cash_entry_exists',
      MESSAGE = format('Cash entry %s does not exist', cash_entry_id);
  END IF;

  CASE application_kind
    WHEN 'CUSTOMER_PAYMENT' THEN
      expected_cash_kind := 'SUBSCRIPTION_PAYMENT';
      check_client := true;
      check_category := true;
      SELECT cp."organizationId", cp."clientId", NULL::UUID,
             cp."receivedOn", NULL::DECIMAL(20,4), NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."CustomerPayment" cp
      WHERE cp."id" = application_id AND cp."cashEntryId" = cash_entry_id;

    WHEN 'LIABILITY_PAYMENT' THEN
      expected_cash_kind := 'LIABILITY_PAYMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      SELECT l."organizationId", l."clientId", l."expenseCategoryId",
             lp."paidOn", lp."appliedAmountUsd", NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."LiabilityPayment" lp
      JOIN public."Liability" l ON l."id" = lp."liabilityId"
      WHERE lp."id" = application_id AND lp."cashEntryId" = cash_entry_id;

    WHEN 'PAYROLL_PAYMENT' THEN
      expected_cash_kind := 'PAYROLL_PAYMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      SELECT pr."organizationId", NULL::UUID, NULL::UUID,
             pp."paidOn", pp."appliedAmountUsd", NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."PayrollPayment" pp
      JOIN public."PayrollItem" pi ON pi."id" = pp."payrollItemId"
      JOIN public."PayrollRun" pr ON pr."id" = pi."payrollRunId"
      WHERE pp."id" = application_id AND pp."cashEntryId" = cash_entry_id;

    WHEN 'ADVANCE_DISBURSEMENT' THEN
      expected_cash_kind := 'ADVANCE_DISBURSEMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      check_original_conversion := true;
      SELECT a."organizationId", NULL::UUID, NULL::UUID,
             a."disbursedOn", a."principalUsd", a."principalOriginal",
             a."currency", a."currencyUnitsPerUsd"
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."Advance" a
      WHERE a."id" = application_id AND a."cashEntryId" = cash_entry_id;

    WHEN 'ADVANCE_REPAYMENT' THEN
      expected_cash_kind := 'ADVANCE_REPAYMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      SELECT a."organizationId", NULL::UUID, NULL::UUID,
             ar."repaidOn", ar."amountUsd", NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."AdvanceRepayment" ar
      JOIN public."Advance" a ON a."id" = ar."advanceId"
      WHERE ar."id" = application_id AND ar."cashEntryId" = cash_entry_id;

    WHEN 'RECURRING_EXPENSE_PAYMENT' THEN
      expected_cash_kind := 'RECURRING_EXPENSE_PAYMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      SELECT ret."organizationId", NULL::UUID, reo."expenseCategoryId",
             rep."paidOn", rep."appliedAmountUsd", NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."RecurringExpensePayment" rep
      JOIN public."RecurringExpenseOccurrence" reo ON reo."id" = rep."occurrenceId"
      JOIN public."RecurringExpenseTemplate" ret ON ret."id" = reo."templateId"
      WHERE rep."id" = application_id AND rep."cashEntryId" = cash_entry_id;

    WHEN 'SERVICE_PAYMENT' THEN
      expected_cash_kind := 'SERVICE_PAYMENT';
      check_client := true;
      check_category := true;
      check_amount := true;
      SELECT ss."organizationId", NULL::UUID, sc."expenseCategoryId",
             sp."paidOn", sp."appliedAmountUsd", NULL::DECIMAL(20,4),
             NULL::"CurrencyCode", NULL::DECIMAL(20,8)
      INTO application_organization_id, application_client_id, application_category_id,
           application_date, application_amount_usd, application_amount_original,
           application_currency, application_rate
      FROM public."ServicePayment" sp
      JOIN public."ServiceCharge" sc ON sc."id" = sp."serviceChargeId"
      JOIN public."ServiceSubscription" ss ON ss."id" = sc."serviceSubscriptionId"
      WHERE sp."id" = application_id AND sp."cashEntryId" = cash_entry_id;
  END CASE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'CashEntryApplication_application_exists',
      MESSAGE = format(
        'Application %s/%s does not exist or does not reference cash entry %s',
        application_kind, application_id, cash_entry_id
      );
  END IF;

  IF cash_status <> 'POSTED'
    OR cash_kind <> expected_cash_kind
    OR cash_organization_id IS DISTINCT FROM application_organization_id
    OR cash_occurred_on IS DISTINCT FROM application_date
    OR (check_client AND cash_client_id IS DISTINCT FROM application_client_id)
    OR (check_category AND cash_category_id IS DISTINCT FROM application_category_id)
    OR (check_amount AND cash_amount_usd IS DISTINCT FROM application_amount_usd)
    OR (check_original_conversion AND (
      cash_amount_original IS DISTINCT FROM application_amount_original
      OR cash_currency IS DISTINCT FROM application_currency
      OR cash_rate IS DISTINCT FROM application_rate
    ))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CashEntryApplication_semantics',
      MESSAGE = format(
        'Cash entry %s does not satisfy the semantics for %s/%s',
        cash_entry_id, application_kind, application_id
      );
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "validate_cash_entry_application_insert"() RETURNS trigger AS $$
BEGIN
  PERFORM public."assert_cash_entry_application"(
    NEW."applicationKind",
    NEW."applicationId",
    NEW."cashEntryId"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashEntryApplication_validate_insert"
BEFORE INSERT ON "CashEntryApplication"
FOR EACH ROW EXECUTE FUNCTION "validate_cash_entry_application_insert"();

CREATE FUNCTION "register_cash_entry_application"() RETURNS trigger AS $$
DECLARE
  application_kind "CashApplicationKind";
BEGIN
  -- Payroll advance deductions are noncash and intentionally have no registry row.
  IF TG_TABLE_NAME = 'AdvanceRepayment' AND NEW."cashEntryId" IS NULL THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'CustomerPayment' THEN application_kind := 'CUSTOMER_PAYMENT';
    WHEN 'LiabilityPayment' THEN application_kind := 'LIABILITY_PAYMENT';
    WHEN 'PayrollPayment' THEN application_kind := 'PAYROLL_PAYMENT';
    WHEN 'Advance' THEN application_kind := 'ADVANCE_DISBURSEMENT';
    WHEN 'AdvanceRepayment' THEN application_kind := 'ADVANCE_REPAYMENT';
    WHEN 'RecurringExpensePayment' THEN application_kind := 'RECURRING_EXPENSE_PAYMENT';
    WHEN 'ServicePayment' THEN application_kind := 'SERVICE_PAYMENT';
    ELSE
      RAISE EXCEPTION 'Unsupported cash application table: %', TG_TABLE_NAME;
  END CASE;

  INSERT INTO public."CashEntryApplication" (
    "cashEntryId", "applicationKind", "applicationId"
  ) VALUES (
    NEW."cashEntryId", application_kind, NEW."id"
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CustomerPayment_register_cash_entry"
AFTER INSERT ON "CustomerPayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "LiabilityPayment_register_cash_entry"
AFTER INSERT ON "LiabilityPayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "PayrollPayment_register_cash_entry"
AFTER INSERT ON "PayrollPayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "Advance_register_cash_entry"
AFTER INSERT ON "Advance"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "AdvanceRepayment_register_cash_entry"
AFTER INSERT ON "AdvanceRepayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "RecurringExpensePayment_register_cash_entry"
AFTER INSERT ON "RecurringExpensePayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE TRIGGER "ServicePayment_register_cash_entry"
AFTER INSERT ON "ServicePayment"
FOR EACH ROW EXECUTE FUNCTION "register_cash_entry_application"();

CREATE FUNCTION "protect_cash_entry_application_registry"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CashEntryApplication rows are immutable and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashEntryApplication_immutable"
BEFORE UPDATE OR DELETE ON "CashEntryApplication"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_entry_application_registry"();

CREATE FUNCTION "protect_cash_application_binding"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are append-only and cannot be deleted', TG_TABLE_NAME;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'CustomerPayment' THEN
      IF (to_jsonb(NEW) - ARRAY['note', 'updatedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['note', 'updatedAt'])
      THEN
        RAISE EXCEPTION 'CustomerPayment application facts are immutable';
      END IF;
    WHEN 'Advance' THEN
      IF (to_jsonb(NEW) - ARRAY['status', 'voidedAt', 'updatedAt', 'note'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'voidedAt', 'updatedAt', 'note'])
      THEN
        RAISE EXCEPTION 'Advance disbursement application facts are immutable';
      END IF;
    WHEN 'AdvanceRepayment' THEN
      IF (to_jsonb(NEW) - ARRAY['reversedAt'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reversedAt'])
      THEN
        RAISE EXCEPTION 'AdvanceRepayment application facts are immutable';
      END IF;
    ELSE
      IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION '% application facts are immutable', TG_TABLE_NAME;
      END IF;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CustomerPayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "CustomerPayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "LiabilityPayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "LiabilityPayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "PayrollPayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "PayrollPayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "Advance_immutable_binding"
BEFORE UPDATE OR DELETE ON "Advance"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "AdvanceRepayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "AdvanceRepayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "RecurringExpensePayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "RecurringExpensePayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE TRIGGER "ServicePayment_immutable_binding"
BEFORE UPDATE OR DELETE ON "ServicePayment"
FOR EACH ROW EXECUTE FUNCTION "protect_cash_application_binding"();

CREATE FUNCTION "validate_cash_entry_application_completeness"() RETURNS trigger AS $$
DECLARE
  expected_application_kind "CashApplicationKind";
  registered_application_kind "CashApplicationKind";
  registered_application_id UUID;
BEGIN
  CASE NEW."kind"
    WHEN 'SUBSCRIPTION_PAYMENT' THEN expected_application_kind := 'CUSTOMER_PAYMENT';
    WHEN 'LIABILITY_PAYMENT' THEN expected_application_kind := 'LIABILITY_PAYMENT';
    WHEN 'PAYROLL_PAYMENT' THEN expected_application_kind := 'PAYROLL_PAYMENT';
    WHEN 'ADVANCE_DISBURSEMENT' THEN expected_application_kind := 'ADVANCE_DISBURSEMENT';
    WHEN 'ADVANCE_REPAYMENT' THEN expected_application_kind := 'ADVANCE_REPAYMENT';
    WHEN 'RECURRING_EXPENSE_PAYMENT' THEN expected_application_kind := 'RECURRING_EXPENSE_PAYMENT';
    WHEN 'SERVICE_PAYMENT' THEN expected_application_kind := 'SERVICE_PAYMENT';
    ELSE expected_application_kind := NULL;
  END CASE;

  SELECT cea."applicationKind", cea."applicationId"
  INTO registered_application_kind, registered_application_id
  FROM public."CashEntryApplication" cea
  WHERE cea."cashEntryId" = NEW."id";

  IF expected_application_kind IS NULL THEN
    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'CashEntry_application_forbidden',
        MESSAGE = format('Cash entry kind %s must not have an application', NEW."kind");
    END IF;
    RETURN NEW;
  END IF;

  IF NOT FOUND OR registered_application_kind <> expected_application_kind THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'CashEntry_application_required',
      MESSAGE = format(
        'Cash entry %s requires exactly one %s application',
        NEW."id", expected_application_kind
      );
  END IF;

  -- New specialized entries must be fully valid while posted. Reversed originals
  -- retain their immutable application/registry history by design.
  IF NEW."status" = 'POSTED' THEN
    PERFORM public."assert_cash_entry_application"(
      registered_application_kind,
      registered_application_id,
      NEW."id"
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "CashEntry_application_complete"
AFTER INSERT OR UPDATE ON "CashEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_cash_entry_application_completeness"();

-- Cash ledger facts are immutable. A correction preserves the original row,
-- inserts one exact opposite entry, and only transitions the original status.
CREATE FUNCTION "validate_cash_entry_insert"() RETURNS trigger AS $$
DECLARE
  original "CashEntry"%ROWTYPE;
BEGIN
  IF NEW."kind" <> 'REVERSAL' THEN
    IF NEW."status" <> 'POSTED' THEN
      RAISE EXCEPTION 'A new non-reversal cash entry must be posted';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO original
  FROM "CashEntry"
  WHERE "id" = NEW."reversalOfId"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reversal target does not exist';
  END IF;
  IF original."kind" = 'REVERSAL' THEN
    RAISE EXCEPTION 'A reversal cash entry cannot itself be reversed';
  END IF;
  IF original."status" <> 'POSTED' THEN
    RAISE EXCEPTION 'Cash entry has already been reversed' USING ERRCODE = '23505';
  END IF;
  IF NEW."status" <> 'POSTED'
    OR NEW."organizationId" IS DISTINCT FROM original."organizationId"
    OR NEW."clientId" IS DISTINCT FROM original."clientId"
    OR NEW."expenseCategoryId" IS DISTINCT FROM original."expenseCategoryId"
    OR NEW."direction" = original."direction"
    OR NEW."occurredOn" < original."occurredOn"
    OR NEW."amountOriginal" IS DISTINCT FROM original."amountOriginal"
    OR NEW."currency" IS DISTINCT FROM original."currency"
    OR NEW."currencyUnitsPerUsd" IS DISTINCT FROM original."currencyUnitsPerUsd"
    OR NEW."amountUsd" IS DISTINCT FROM original."amountUsd"
    OR NEW."paymentMethod" IS DISTINCT FROM original."paymentMethod"
  THEN
    RAISE EXCEPTION 'Reversal must exactly offset its original cash entry';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashEntry_validate_reversal_insert"
BEFORE INSERT ON "CashEntry"
FOR EACH ROW EXECUTE FUNCTION "validate_cash_entry_insert"();

CREATE FUNCTION "prevent_cash_entry_fact_mutation"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."expenseCategoryId" IS DISTINCT FROM OLD."expenseCategoryId"
    OR NEW."direction" IS DISTINCT FROM OLD."direction"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."occurredOn" IS DISTINCT FROM OLD."occurredOn"
    OR NEW."amountOriginal" IS DISTINCT FROM OLD."amountOriginal"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."currencyUnitsPerUsd" IS DISTINCT FROM OLD."currencyUnitsPerUsd"
    OR NEW."amountUsd" IS DISTINCT FROM OLD."amountUsd"
    OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
    OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."note" IS DISTINCT FROM OLD."note"
    OR NEW."externalReference" IS DISTINCT FROM OLD."externalReference"
    OR NEW."reversalOfId" IS DISTINCT FROM OLD."reversalOfId"
    OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'CashEntry financial facts are immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" <> 'POSTED' OR NEW."status" <> 'REVERSED' THEN
      RAISE EXCEPTION 'Invalid CashEntry status transition';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "CashEntry" reversal
      WHERE reversal."reversalOfId" = OLD."id" AND reversal."kind" = 'REVERSAL'
    ) THEN
      RAISE EXCEPTION 'CashEntry cannot be marked reversed without a compensating entry';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashEntry_immutable_facts"
BEFORE UPDATE ON "CashEntry"
FOR EACH ROW EXECUTE FUNCTION "prevent_cash_entry_fact_mutation"();

CREATE FUNCTION "prevent_cash_entry_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CashEntry rows are append-only and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CashEntry_no_delete"
BEFORE DELETE ON "CashEntry"
FOR EACH ROW EXECUTE FUNCTION "prevent_cash_entry_delete"();

CREATE FUNCTION "protect_advance_repayment_history"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AdvanceRepayment rows are append-only and cannot be deleted';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."advanceId" IS DISTINCT FROM OLD."advanceId"
    OR NEW."cashEntryId" IS DISTINCT FROM OLD."cashEntryId"
    OR NEW."payrollItemId" IS DISTINCT FROM OLD."payrollItemId"
    OR NEW."amountUsd" IS DISTINCT FROM OLD."amountUsd"
    OR NEW."repaidOn" IS DISTINCT FROM OLD."repaidOn"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'AdvanceRepayment financial facts are immutable';
  END IF;

  IF NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" AND (
    OLD."reversedAt" IS NOT NULL
    OR NEW."reversedAt" IS NULL
    OR OLD."payrollItemId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Invalid AdvanceRepayment reversal transition';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdvanceRepayment_immutable_history"
BEFORE UPDATE OR DELETE ON "AdvanceRepayment"
FOR EACH ROW EXECUTE FUNCTION "protect_advance_repayment_history"();

-- Audit events are append-only. Corrections create a new event instead of mutating history.
CREATE FUNCTION "prevent_audit_event_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditEvent_append_only"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION "prevent_audit_event_mutation"();

COMMIT;
