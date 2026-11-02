ALTER TABLE request_events ADD COLUMN IF NOT EXISTS downstream_request_id VARCHAR;

CREATE INDEX IF NOT EXISTS request_events_user_downstream
  ON request_events (user_id, downstream_request_id, started_at);
