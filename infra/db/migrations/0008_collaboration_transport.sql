-- Existing rooms remain on the transport they were created with. New rooms
-- select their transport explicitly in the application insert.
ALTER TABLE collaboration_rooms
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'upstash-realtime'
  CHECK (transport IN ('upstash-realtime', 'cloudflare-websocket'));
