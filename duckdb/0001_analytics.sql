CREATE TABLE IF NOT EXISTS request_events (
  id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  api_key_id VARCHAR,
  provider_id VARCHAR NOT NULL,
  provider_kind VARCHAR NOT NULL,
  model VARCHAR NOT NULL,
  upstream_model VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  http_status INTEGER,
  error_kind VARCHAR,
  streamed BOOLEAN NOT NULL,
  input_tokens BIGINT,
  output_tokens BIGINT,
  total_tokens BIGINT,
  cost_usd DOUBLE,
  ttft_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  tokens_per_second DOUBLE,
  started_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS request_events_user_time
  ON request_events (user_id, started_at);
