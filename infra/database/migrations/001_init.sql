-- JARVIS license & billing schema (PostgreSQL 14+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'support', 'admin')),
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ip          text,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE plans (
  code           text PRIMARY KEY,
  name           text NOT NULL,
  amount         integer NOT NULL CHECK (amount >= 0),
  currency       text NOT NULL,
  interval       text NOT NULL CHECK (interval IN ('month', 'year')),
  interval_count integer NOT NULL DEFAULT 1,
  entitlements   jsonb NOT NULL DEFAULT '[]',
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code            text NOT NULL REFERENCES plans(code),
  status               text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled', 'expired', 'suspended')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  provider             text NOT NULL DEFAULT 'manual',
  provider_ref         text,
  suspended_reason     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions(user_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status, current_period_end);
CREATE UNIQUE INDEX subscriptions_provider_ref_idx ON subscriptions(provider, provider_ref) WHERE provider_ref IS NOT NULL;

CREATE TABLE licenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  key_hash        text NOT NULL UNIQUE,
  key_last4       text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  max_devices     integer NOT NULL DEFAULT 2 CHECK (max_devices >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX licenses_user_idx ON licenses(user_id);

CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id  uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  name        text NOT NULL DEFAULT '',
  platform    text NOT NULL DEFAULT '',
  app_version text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  last_ip     text,
  UNIQUE (license_id, fingerprint)
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  subscription_id     uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider            text NOT NULL,
  provider_payment_id text NOT NULL,
  plan_code           text,
  amount              integer NOT NULL,
  currency            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('succeeded', 'failed', 'refunded')),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

CREATE TABLE webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  type              text NOT NULL,
  status            text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  error             text,
  payload           jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE checkout_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code  text NOT NULL REFERENCES plans(code),
  provider   text NOT NULL,
  reference  text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL,
  actor_id    text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          text,
  details     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_ts_idx ON audit_events(ts DESC);
CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (code, name, amount, currency, interval, interval_count, entitlements) VALUES
  ('monthly', 'JARVIS Monthly', 4000, 'PKR', 'month', 1, '["premium.execution","agents.all","voice","computer-control","browser","research","coding"]'),
  ('yearly',  'JARVIS Yearly', 40000, 'PKR', 'year',  1, '["premium.execution","agents.all","voice","computer-control","browser","research","coding"]');

INSERT INTO settings (key, value) VALUES
  ('grace_hours', '0'),
  ('canceled_keeps_access_until_period_end', 'true'),
  ('default_max_devices', '2'),
  ('token_ttl_hours', '72'),
  ('bank_transfer_instructions', '"Transfer the plan amount to the account shown on your invoice and include the payment reference. Access is activated once the payment is confirmed."');
