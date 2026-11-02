-- Additive only: existing finance records and the configured owner are untouched.
CREATE TYPE "AppUserRole" AS ENUM ('VIEWER', 'EDITOR');
CREATE TABLE "AppUser" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "username" VARCHAR(64) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "passwordHash" VARCHAR(256) NOT NULL,
  "role" "AppUserRole" NOT NULL DEFAULT 'VIEWER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AppUser_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AppUser_username_format" CHECK ("username" ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT "AppUser_version_positive" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "AppUser_organizationId_username_key" ON "AppUser"("organizationId", "username");
