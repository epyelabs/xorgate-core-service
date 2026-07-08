-- kvs-webrtc-lts §13 T2: catch-all DEFAULT partition for telemetry_readings.
--
-- telemetry_readings is monthly RANGE(ts)-partitioned. A `ts` outside every defined
-- month (a skewed device clock — RTC-less Pi, NTP not synced — or the pre-created
-- months running out because partition-maintenance was gated/failed) would otherwise
-- HARD-FAIL the insert. With a DEFAULT partition the row still lands and stays
-- queryable; combined with the T1 persist isolation, a partition miss now degrades
-- gracefully instead of cascading into the status heartbeat.
--
-- Caveat: once the DEFAULT partition holds rows, creating a new specific monthly
-- partition takes an ACCESS EXCLUSIVE lock while Postgres verifies none of the
-- default's rows belong in the new range. In steady state the default stays empty
-- (only skewed-clock rows land there) and partition-maintenance pre-creates months
-- 0/+1/+2 ahead, so this is a safety net, not the hot path.
--
-- Apply out-of-band via the RDS Data API (see manual/README.md), after the latest
-- generated migration. Idempotent via the guard below.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'telemetry_readings'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  ) THEN
    CREATE TABLE telemetry_readings_default PARTITION OF telemetry_readings DEFAULT;
  END IF;
END $$;
