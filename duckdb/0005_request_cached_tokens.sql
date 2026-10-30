ALTER TABLE request_events ADD COLUMN IF NOT EXISTS cached_input_tokens BIGINT;
