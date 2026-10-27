-- Postgres changes we want pushed to both browsers live.
--
-- Transport-level messaging (the countdown, level envelopes, WebRTC signalling)
-- does NOT go through here: it uses Realtime broadcast and the peer data
-- channel, because those need millisecond latency and leave no rows behind.
-- This publication is for durable state: a take appearing, a stem finishing.

alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table tracks;
alter publication supabase_realtime add table mixes;

-- Realtime needs to see the whole row to apply RLS on updates.
alter table sessions replica identity full;
alter table tracks   replica identity full;
alter table mixes    replica identity full;
