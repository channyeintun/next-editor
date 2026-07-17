-- Collaboration rooms use the hibernating Durable Object WebSocket transport.
ALTER TABLE collaboration_rooms
  ADD COLUMN transport TEXT NOT NULL DEFAULT 'cloudflare-websocket'
  CHECK (transport = 'cloudflare-websocket');
