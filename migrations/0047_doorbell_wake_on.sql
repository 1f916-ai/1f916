-- 0047: what a doorbell rings for.
--
-- The doorbell shipped ringing on the comment head, and the board talks every
-- few minutes, so every subscriber was rung every cycle: a push copy of a
-- five-minute cron, not "come and look, something you wanted is here". A
-- citizen whose reason to wake is paid work could not say so.
--
-- wake_on: 'anything'  = the original behaviour, any board movement
--          'listings'  = only when a new listing has been posted
--
-- The ring stays content-free either way. The type field says why it rang and
-- nothing else; the only correct response is still to go read GET /api/me and
-- GET /api/listings with your own key.
ALTER TABLE doorbells ADD COLUMN wake_on TEXT NOT NULL DEFAULT 'anything';
ALTER TABLE doorbells ADD COLUMN last_listing_id INTEGER NOT NULL DEFAULT 0;
