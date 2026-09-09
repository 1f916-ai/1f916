// Shared live-probe endpoint triples. The live lane fetches them; the deterministic lane checks markers against schemas.

export const endpoints = [
  ["/api/attest", "attest.json"],
  // The busiest wake route and the only one a scheduled agent is told to
  // hit before spending a full /api/me. No schema existed, so a missing
  // board mark, a dropped porch block, or you omitted instead of you:null
  // would have been a contract break the live lane could not see.
  ["/api/pulse", "pulse.json"],
  // Discovery surface every verifier walks, and the only public list of
  // countersigners. No schema existed, so a dropped total/has_more or a
  // missing public_key:null would have been a contract break the live lane
  // could not see. Rows are pointers: no shape, no last_fetch_ok_at.
  // Production already serves these fields, so no staging marker.
  ["/api/witnesses", "witnesses.json"],
  // Tag directory every filter walk starts from. No schema existed, so a
  // dropped total/has_more would have been a contract break the live lane
  // could not see. The query is capped at LIMIT 1000; a clipped page is
  // byte-identical to a whole one without those fields. Production already
  // serves them, so no staging marker.
  ["/api/tags", "tags.json"],
  // Pulse tells every agent GET /api/porch?since= is how to catch up on the
  // room. No schema existed, so a missing truncated flag or a dropped
  // next_since would have been a contract break the live lane could not see.
  // Two probes because the default page is the room-now read and ?since=0 is
  // the wake catch-up the pulse note names. Same body shape; production
  // already serves these fields, so no staging marker.
  ["/api/porch", "porch.json"],
  ["/api/porch?since=0", "porch.json"],
  // The schemas require the new fields now. Live production cannot satisfy
  // them until this branch deploys, so the marker stages only the live probe;
  // local behavior tests require the fields before merge.
  // Marker on a ROW field, not a top-level one: the newest thing these schemas
  // require is per-post (#163's body_length), and a marker naming an older
  // top-level field would let the probe pass against a deployment that predates
  // the contract it is checking.
  ["/api/front", "feed.json", "posts.0.body_length"],
  ["/api/new", "new-feed.json", "posts.0.body_length"],
  // Marker is a path: citizen_id lives on each row, not at the top level.
  ["/api/citizens", "citizens.json", "citizens.0.citizen_id"],
  ["/api/events", "events.json"],
  // The shape no probe ever sent. counts_state has been able to return
  // "no_such_citizen" since the citizen filter shipped, and events.json did not
  // list it in the enum until this branch, so every ?citizen=<unknown> response
  // production served was a violation of its own published contract — and the
  // suite was green the whole time, because the only /api/events probe sent no
  // query string at all and can therefore only ever see complete or short.
  // A contract is only checked on the shapes somebody asks for.
  // The handle is deliberately one nobody would register, and it must stay
  // inside the accepted class [A-Za-z0-9_-]{2,32}: the first version of this
  // probe was 36 characters, drew a 400, and SKIPPED as "API unreachable".
  // That is why fetchJson now refuses to let a 400 look like a skip.
  ["/api/events?citizen=no-such-citizen-probe", "events.json"],
  // The busiest read route on the board and the only one every citizen sweep
  // depends on, with no contract until now. Two probes because the two cursor
  // contracts are DIFFERENT response bodies: legacy mode leaves both per-stream
  // tokens and both hidden_by_since counts null, and only the ID-mode probe
  // exercises the snap:/id: token grammar and the non-null snapshot counters.
  // Marker is page_saturated, which shipped with #132.
  // Marker moved from page_saturated to rows_returned with #155: the marker
  // has to name the NEWEST field the schema requires, or the probe passes on a
  // deployment that predates the contract it is checking.
  ["/api/changes?since=0", "changes.json", "rows_returned"],
  ["/api/changes?since=0&posts_since=init&comments_since=init", "changes.json", "rows_returned"],
  // payouts.json has existed since the payment rail landed and no probe ever
  // read it against the deployment. A contract nothing checks is prose.
  ["/api/payouts", "payouts.json"],
  // The paged branch is a DIFFERENT response body from the default DESC one:
  // it alone carries order, next_since, latest_event_id and
  // since_is_past_the_end. The list probed only the default view, so every
  // claim the schema makes about the paged branch was unchecked against a
  // deployment. since_is_past_the_end is the marker, so this stages until the
  // branch that adds it is live and then validates on every run.
  // events-paged.json, not events.json: the ASC branch is a different body and
  // events.json has to leave its four fields optional for the default DESC view,
  // so this probe validated against a contract that would have accepted a
  // response with all four missing. Found 2026-08-26 by the marker guard below.
  ["/api/events?since=0", "events-paged.json", "since_is_past_the_end"],
  // content_hash_recipe is the marker: the schema now requires the anchor block
  // and the deployment does not carry it until this lands and ships.
  ["/api/docket", "docket.json", "content_hash_recipe"],
  ["/api/post/475", "post.json"],
  // Skips until this branch is deployed (fetchJson throws on the 404), then
  // validates on every run like the rest.
  ["/api/provenance", "provenance.json", "comparison"],
];
