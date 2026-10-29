CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,
  end_raw   text NOT NULL,
  start_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS slots_start_at ON slots (start_at);

CREATE TABLE IF NOT EXISTS bookings (
  seq          bigserial PRIMARY KEY,
  id           text NOT NULL UNIQUE,
  slot_id      text NOT NULL REFERENCES slots (id) ON DELETE CASCADE,
  name         text NOT NULL,
  email        text NOT NULL,
  status       text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

-- Level 3: the database itself refuses a second confirmed booking for a slot.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency (
  key         text PRIMARY KEY,
  body_hash   text NOT NULL,
  status_code integer,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_events (
  id    bigserial PRIMARY KEY,
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_events_email_at ON rate_events (email, at);
