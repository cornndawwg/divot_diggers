-- =============================================================================
-- Migration 0004 — Better Auth tables
--
-- Beyond the docs/schema.sql baseline. The DDL below is exactly what Better Auth
-- 1.7 generates for email + password auth; it was produced by running Better
-- Auth's own migrator against a scratch database and dumping the result, so the
-- columns are what the library expects rather than a hand transcription.
--
-- These are credential tables, not domain tables, so they carry no
-- organization_id: `user` is global identity in the same way `people` is. The
-- link between them is people.auth_user_id -> user.id.
--
-- SECURITY. `account` holds password hashes and `session` holds live session
-- tokens. Nothing reachable by an end-user connection may read either. Two
-- independent protections, because one of them is a deployment detail that can
-- be got wrong:
--
--   1. Only the privileged auth connection touches these tables. It owns them,
--      so it bypasses RLS.
--   2. RLS is enabled with an explicit deny-all policy. docs/schema.sql notes
--      that RLS with no policy already denies everything, but an explicit
--      USING (false) states the intent rather than leaving it to be inferred
--      from an absence — and it survives someone running
--      GRANT SELECT ON ALL TABLES to the app role.
--
-- The isolation suite asserts an app-role connection reads zero password hashes
-- and zero session tokens even when granted SELECT on everything.
-- =============================================================================

CREATE TABLE "user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);

CREATE TABLE account (
    id text NOT NULL,
    issuer text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY "user" ADD CONSTRAINT user_pkey PRIMARY KEY (id);
ALTER TABLE ONLY "user" ADD CONSTRAINT user_email_key UNIQUE (email);
ALTER TABLE ONLY session ADD CONSTRAINT session_pkey PRIMARY KEY (id);
ALTER TABLE ONLY session ADD CONSTRAINT session_token_key UNIQUE (token);
ALTER TABLE ONLY account ADD CONSTRAINT account_pkey PRIMARY KEY (id);
ALTER TABLE ONLY verification ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE ONLY account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON account USING btree (issuer, "accountId");
CREATE INDEX "account_userId_idx" ON account USING btree ("userId");
CREATE INDEX "session_userId_idx" ON session USING btree ("userId");
CREATE INDEX verification_identifier_idx ON verification USING btree (identifier);

-- Deny-all, per the security note above.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_owner_only ON "user" FOR ALL USING (false);
CREATE POLICY auth_owner_only ON session FOR ALL USING (false);
CREATE POLICY auth_owner_only ON account FOR ALL USING (false);
CREATE POLICY auth_owner_only ON verification FOR ALL USING (false);
