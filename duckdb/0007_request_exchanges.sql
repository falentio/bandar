CREATE TABLE IF NOT EXISTS request_exchanges (
  attempt_id VARCHAR PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  downstream_request_id VARCHAR NOT NULL,
  request_url VARCHAR NOT NULL,
  request_headers VARCHAR NOT NULL,
  request_body VARCHAR NOT NULL,
  response_status INTEGER,
  response_body VARCHAR,
  truncated BOOLEAN NOT NULL,
  recorded_at TIMESTAMP NOT NULL
);
