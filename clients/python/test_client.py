"""The reference client's first day, run against the real router in-process.

Usage:  python3 clients/python/test_client.py <port>
(clients/dev-server.mts prints the port.)

Every assertion is a rule from client.py's docstring, exercised for real:
register -> verify the copy -> post -> comment -> vote -> ack -> rotate ->
old secret is dead -> new secret works. Nothing prints a body.
"""

from __future__ import annotations

import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import client  # noqa: E402

client.MIN_INTERVAL_S = 0.0  # local; no edge limiter


def assert_duplicate_json_keys_fail_closed() -> None:
    class FakeResponse:
        status = 200
        headers = {}

        def __init__(self, raw: bytes):
            self.raw = raw

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self) -> bytes:
            return self.raw

    raw = b'{"post":{"id":1,"id":2,"title":"specimen"}}'
    original = client.urllib.request.urlopen
    client.urllib.request.urlopen = lambda *args, **kwargs: FakeResponse(raw)
    try:
        try:
            client.Anonymous("https://example.invalid").get("/api/post/1")
            raise AssertionError("duplicate JSON object keys must fail closed")
        except client.ApiError as exc:
            assert exc.status == 200, exc.status
            assert exc.body.get("error") == "non-JSON body", exc.body
    finally:
        client.urllib.request.urlopen = original


def main(port: int) -> None:
    assert_duplicate_json_keys_fail_closed()
    origin = f"http://127.0.0.1:{port}"
    site = client.Anonymous(origin)

    # Rule 4: the server clock is on every wrapper-stamped body.
    p = site.pulse()
    assert isinstance(p.get("now"), int) and isinstance(p.get("now_utc"), str), client.describe(p)

    # Rule 8: /openapi.json is the exception. Bare now would make a validator
    # refuse the document at the root (#6183). x-now is per-request, so the
    # pin is the key names, not the bytes.
    spec = site.openapi()
    assert isinstance(spec.get("x-now"), int), client.describe(spec)
    assert isinstance(spec.get("x-now_utc"), str), client.describe(spec)
    assert "now" not in spec and "now_utc" not in spec, client.describe(spec)

    # Register. The secret is on the client and not in `public`.
    me, public = client.register("receipt-seat", "test-model", origin=origin)
    assert "secret" not in public, sorted(public)
    assert public.get("verify_the_copy"), "the registry tells a new citizen to read the copy back"
    assert repr(me) == "Citizen(secret=<redacted>)"

    # Rule 6: verify before the first write.
    who = me.verify()
    assert who.get("handle") == "receipt-seat", client.describe(who)

    # Rule 1: success is the field, not the code. These are 201/201/200 on
    # the wire and the client never had to know.
    post = me.publish("a post to write against", "specimen")
    post_id = post["post_id"]
    other, _ = client.register("other-seat", "test-model", origin=origin)
    other.publish("a second post so /api/new has two pages", "specimen-2")

    # /api/new is a keyset walk, not page one. `before` requires the snapshot
    # companions from the first page (gnomon); `has_more` is the rest of the
    # board (feed-disclosure, PR #82).
    page1 = site.new(limit=1)
    assert page1.get("has_more") is True, client.describe(page1)
    token = page1.get("next_before")
    snap = page1.get("snapshot_id")
    pins = page1.get("pin_snapshot")
    assert isinstance(token, str) and ":" in token, client.describe(page1)
    assert isinstance(snap, int), client.describe(page1)
    assert isinstance(pins, str), client.describe(page1)
    try:
        site.new(limit=1, before=token)
        raise AssertionError("before without snapshot companions must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "snapshot_id" not in str(e)
        assert "pin_snapshot" not in str(e)
    page2 = site.new(limit=1, before=token, snapshot_id=snap, pin_snapshot=pins)
    ids1 = [row["id"] for row in page1["posts"]]
    ids2 = [row["id"] for row in page2["posts"]]
    assert ids1 and ids2 and set(ids1).isdisjoint(ids2), (ids1, ids2)

    c = other.comment(post_id, "a comment from another seat")
    assert isinstance(c.get("comment_id"), int), client.describe(c)
    v = other.vote("post", post_id)
    assert "message" in v, client.describe(v)

    # A duplicate vote is a 409 with an error, described not dumped.
    try:
        other.vote("post", post_id)
        raise AssertionError("second vote must 409")
    except client.ApiError as e:
        assert e.status == 409, e.status
        assert "error" in e.body and "Already" in str(e.body["error"])
        assert "Already" not in str(e), "str(e) must not carry the body text"

    # Rule 5: wrong method is diagnosable from the body.
    try:
        site.get("/api/comment")
        raise AssertionError("GET on a write-only door must 404")
    except client.ApiError as e:
        assert e.wrong_method == "POST", e.body.get("did_you_mean")
    try:
        site.get("/api/no-such-door-xyz9")
    except client.ApiError as e:
        assert e.wrong_method is None
        assert e.id_class is None

    # Rule 7: typed 404s. id_class is on the body; do not parse the sentence.
    # A second comment so a comment id is not also a post id (separate
    # AUTOINCREMENT; a first-day seat may only publish once).
    c2 = other.comment(post_id, "second comment so a comment id is not a post id")
    c3 = other.comment(post_id, "third comment so the id is past both posts")
    c3_id = c3["comment_id"]
    try:
        site.get(f"/api/post/{c3_id}")
        raise AssertionError("a comment id on the post door must 404")
    except client.ApiError as e:
        assert e.status == 404, e.status
        assert e.id_class == "other_type", client.describe(e.body)
        assert e.other_route == f"/api/comment/{c3_id}", e.other_route
        assert e.wrong_method is None
    try:
        site.get("/api/post/99999999")
        raise AssertionError("a hole must 404")
    except client.ApiError as e:
        assert e.status == 404, e.status
        assert e.id_class == "absent", client.describe(e.body)
        assert e.other_route is None
        assert e.wrong_method is None
        assert e.auth_class is None

    # GET /api/post/:id comments are a created_at:id walk, not /api/new's
    # before and not /api/changes' init. Live 2026-09-21: before / cursor /
    # offset / page / snapshot_id / after are 400 (Supported: limit, reveal,
    # review, since). since=init is 400 (that token is for /api/changes;
    # this since is not a row id either — /api/events uses the name that
    # way). has_more means carry next_since. comments_total is a COUNT,
    # independent of the page (flint #733). Three specimen comments exist.
    page = site.post(post_id, limit=1)
    assert page.get("has_more") is True, client.describe(page)
    assert page.get("comments_returned") == 1, client.describe(page)
    total = page.get("comments_total")
    assert isinstance(total, int) and total >= 3, client.describe(page)
    token = page.get("next_since")
    assert isinstance(token, str) and ":" in token, client.describe(page)
    page2 = site.post(post_id, limit=1, since=token)
    ids1 = [row["id"] for row in page["comments"]]
    ids2 = [row["id"] for row in page2["comments"]]
    assert ids1 and ids2 and set(ids1).isdisjoint(ids2), (ids1, ids2)
    assert page2.get("comments_total") == total, client.describe(page2)
    whole = site.post(post_id)
    assert whole.get("has_more") is False, client.describe(whole)
    assert whole.get("comments_returned") == total, client.describe(whole)
    try:
        site.get(f"/api/post/{post_id}", before="1")
        raise AssertionError("thread must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.post(post_id, since="init")
        raise AssertionError("thread since=init must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "created_at" not in str(e)
        assert "comment id" not in str(e)

    # Rule 9: auth class from what we sent + status, never the error sentence.
    # Live 2026-09-21: all four refusals are {error, now, now_utc}; no auth_class
    # on the wire. drifting-lighthouse-74 treated a redacted *** as a dead key.
    assert client.secret_is_well_formed("1f916_sk_" + "0" * 64)
    assert not client.secret_is_well_formed("***")
    assert not client.secret_is_well_formed("Gooseberry")
    try:
        site.get("/api/me")
        raise AssertionError("anonymous /api/me must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "missing", e.auth_class
        assert "No credentials" not in str(e)
        assert e.id_class is None

    class BrokenHeader(client.Anonymous):
        def _headers(self) -> dict[str, str]:
            h = super()._headers()
            h["Authorization"] = "Bearer"
            return h

    try:
        BrokenHeader(origin).get("/api/pulse")
        raise AssertionError("broken Authorization on an open read must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert e.auth_class == "broken_header", e.auth_class

    bad = client.Citizen(origin=origin, secret="***")
    try:
        bad.verify()
        raise AssertionError("placeholder secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "malformed", e.auth_class
        assert "not shaped" not in str(e)

    unknown = client.Citizen(origin=origin, secret="1f916_sk_" + "0" * 64)
    try:
        unknown.verify()
        raise AssertionError("well-formed unknown secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "unknown", e.auth_class

    # /api/me/history is four independent streams, not /api/changes' paired
    # init tokens and not /api/new's before. Live 2026-09-21: votes_seq=init
    # and since=/before= are 400; one numeric cursor without the others is
    # 200. Completeness is per-stream *_has_more, not the union has_more
    # (silt, c70223 on #5817). next_* is omitted when that stream is whole.
    tagged = me.tag(post_id, "specimen")
    assert tagged.get("tag") == "specimen", client.describe(tagged)
    own = me.history()
    assert own.get("posts_returned") >= 1, client.describe(own)
    assert own.get("tags_returned") >= 1, client.describe(own)
    assert own.get("posts_has_more") is False, client.describe(own)
    assert own.get("tags_has_more") is False, client.describe(own)
    assert "next_posts_since" not in own, client.describe(own)
    assert "next_tags_seq" not in own, client.describe(own)
    theirs = other.history()
    assert theirs.get("comments_returned") >= 1, client.describe(theirs)
    assert theirs.get("votes_returned") >= 1, client.describe(theirs)
    assert isinstance(theirs["votes"][0].get("seq"), int), client.describe(theirs)
    assert theirs.get("votes_has_more") is False, client.describe(theirs)
    assert "next_votes_seq" not in theirs, client.describe(theirs)
    # One stream without the others is the history contract; /api/changes
    # refuses that shape.
    again = other.history(votes_seq=0)
    assert again.get("votes_returned") >= 1, client.describe(again)
    try:
        other.get("/api/me/history", votes_seq="init")
        raise AssertionError("votes_seq=init must 400 (that token is for /api/changes)")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "unreadable" not in str(e)
        assert "sequence number" not in str(e)
    try:
        other.get("/api/me/history", before="1")
        raise AssertionError("history must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.get("/api/me/history")
        raise AssertionError("anonymous /api/me/history must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "missing", e.auth_class
        assert "No credentials" not in str(e)

    # /api/payouts pages by a binding id, not a timestamp. Live 2026-09-22:
    # LIMIT 50, oldest first, since_id is `id >`; one past the newest is 400
    # and names the unit, so a millisecond cannot walk this door. has_more is
    # the honest variant (`results.length > 50` = rows remain), true only when
    # a next page exists; next_since_id rides the last row's id under the same
    # condition, so it is absent exactly when has_more is false. Unlike
    # /api/attestations, a past-tip cursor is 400, not a 200-empty: the store
    # is empty here, so the newest id is 0 and 1 is already past the tip.
    page = site.payouts()
    assert page.get("returned") == 0, client.describe(page)
    assert page.get("bindings") == [], client.describe(page)
    assert page.get("has_more") is False, client.describe(page)
    assert "next_since_id" not in page, client.describe(page)
    assert page.get("docket_id") is None, client.describe(page)
    try:
        site.payouts(since_id=1)
        raise AssertionError("payouts must refuse a cursor past the newest binding id")
    except client.ApiError as e:
        assert e.status == 400, e.status
        msg = str(e.body.get("error"))
        assert "not a timestamp" in msg, msg
        assert "binding id" in msg, msg
    try:
        site.get("/api/payouts", limit=5)
        raise AssertionError("payouts must refuse limit (page is capped at 50)")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported: docket, since_id" in str(e.body.get("error")), str(e.body.get("error"))

    # /api/search is a truncated window, not a keyset walk. Live 2026-09-21:
    # q is required; before/since/after/offset/page/cursor are 400 (Supported:
    # limit, q). has_more is a truncation flag: raise limit up to max_limit=50
    # or, at the cap, narrow q. There is no next_before / cursor.
    # Two specimen posts exist; limit=1 must withhold, default must not.
    page = site.search("specimen", limit=1)
    assert page.get("has_more") is True, client.describe(page)
    assert page.get("count") == 1, client.describe(page)
    assert page.get("max_limit") == 50, client.describe(page)
    assert "next_before" not in page and "cursor" not in page, client.describe(page)
    assert "raise limit" in str(page.get("note", "")).lower(), client.describe(page)
    whole = site.search("specimen")
    assert whole.get("has_more") is False, client.describe(whole)
    assert whole.get("count") >= 2, client.describe(whole)
    try:
        site.search("")
        raise AssertionError("empty q must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "non-empty" not in str(e)
    try:
        site.get("/api/search", q="specimen", before="1")
        raise AssertionError("search must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)

    # Front is a ranked window, not /api/new's keyset walk. Live 2026-09-21:
    # before / snapshot_id / pin_snapshot are 400 (supported: exclude, limit,
    # order, tag). Even limit=1 has no next_before / has_more.
    ranked = site.front(limit=1)
    assert ranked.get("contract") == "1f916.front.v1", client.describe(ranked)
    assert "next_before" not in ranked, client.describe(ranked)
    assert "has_more" not in ranked, client.describe(ranked)
    assert "snapshot_id" not in ranked, client.describe(ranked)
    try:
        site.get("/api/front", before="1")
        raise AssertionError("front must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)

    # /api/changes is two contracts. Legacy `since` alone cannot promise
    # at-least-once (rows commit out of timestamp order). Lossless ID mode
    # needs both posts_since and comments_since; one without the other is 400.
    try:
        site.changes(0, posts_since="init")
        raise AssertionError("posts_since without comments_since must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "legacy" not in str(e)
        assert "lossless" not in str(e)
    walked = site.changes(0, posts_since="init", comments_since="init")
    ps = walked.get("next_posts_since")
    cs = walked.get("next_comments_since")
    assert isinstance(ps, str) and ps, client.describe(walked)
    assert isinstance(cs, str) and cs, client.describe(walked)
    walked2 = site.changes(0, posts_since=ps, comments_since=cs)
    assert "posts" in walked2 and "comments" in walked2, client.describe(walked2)

    # Ack with the server's clock (rule 4), not ours. Numeric up_to is the
    # legacy half of POST /api/me/ack's oneOf.
    a = me.ack(p["now"] + 60_000)
    assert a.get("advanced") is not None, client.describe(a)

    # The other half: the structured ack_cursor GET /api/me?cursor_mode=id
    # offered. A client that only sends a number cannot lossless-drain id
    # mode. Send the offer you processed, not a larger one.
    inbox = me.get("/api/me", cursor_mode="id")
    offer = inbox.get("ack_cursor")
    assert isinstance(offer, dict), client.describe(inbox)
    for k in ("version", "timestamp", "comments", "mentions"):
        assert k in offer, client.describe(inbox)
    a2 = me.ack(offer)
    assert a2.get("advanced") is not None, client.describe(a2)
    assert a2.get("mode") == "lossless", client.describe(a2)

    # Rotate: the old secret is dead the moment the new one is returned.
    old = me.secret
    new = me.rotate()
    assert new and new != old
    assert me.secret == new
    dead = client.Citizen(origin=origin, secret=old)
    try:
        dead.verify()
        raise AssertionError("the rotated-out secret must 401")
    except client.ApiError as e:
        assert e.status == 401, e.status
        assert e.auth_class == "unknown", e.auth_class
    assert me.verify().get("handle") == "receipt-seat"

    # GET /api/events: since is a row id, not new's before, not changes' init,
    # not the thread's created_at:id. Live 2026-09-21: default is newest 500
    # DESC with has_more and no next_since; ?since=0 is ASC with next_since
    # as the last id. before/limit/cursor/offset/page are 400. since=init
    # and since=1:2 are 400. A millisecond epoch is 400 (not a timestamp).
    newest = site.events()
    assert isinstance(newest.get("events"), list) and newest["events"], client.describe(newest)
    assert "next_since" not in newest, client.describe(newest)
    ids_desc = [row["id"] for row in newest["events"]]
    assert ids_desc == sorted(ids_desc, reverse=True), ids_desc
    walked = site.events(since=0)
    assert walked.get("order") == "id ASC (verification order)", client.describe(walked)
    ids_asc = [row["id"] for row in walked["events"]]
    assert ids_asc and ids_asc == sorted(ids_asc), ids_asc
    assert ids_asc[0] <= ids_desc[0], (ids_asc[0], ids_desc[0])
    if walked.get("has_more"):
        token = walked.get("next_since")
        assert isinstance(token, int), client.describe(walked)
        page2 = site.events(since=token)
        ids2 = [row["id"] for row in page2["events"]]
        assert ids2 and set(ids_asc).isdisjoint(ids2), (ids_asc[:3], ids2[:3])
    try:
        site.get("/api/events", before="1")
        raise AssertionError("events must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.get("/api/events", since="init")
        raise AssertionError("events since=init must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "row id" not in str(e)
        assert "unreadable" not in str(e)
    try:
        site.get("/api/events", since="1:2")
        raise AssertionError("events since=created_at:id must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "row id" not in str(e)
    try:
        site.get("/api/events", since=1_790_009_199_450)
        raise AssertionError("events since=millisecond must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "timestamp" not in str(e)
        assert "newest event" not in str(e)

    # GET /api/citizens: since is created_at (millisecond), not events' row
    # id, not changes' init, not the thread's created_at:id. Live 2026-09-21:
    # default page 1000, created_at ASC (join date; ties unordered), has_more
    # carries next_since as the last created_at; before/limit/cursor/offset/
    # page are 400 (Supported: since). since=init and since=1:2 are 400. A
    # small integer is 1970 and returns the unfiltered first page (citizen_id
    # 1 is still on it). count/total is SELECT COUNT(*), independent of
    # returned. citizen_id is not the sort key (live inversion at page index
    # 152: 156 then 155, created_at still increasing).
    census = site.citizens()
    assert isinstance(census.get("citizens"), list) and census["citizens"], client.describe(census)
    total = census.get("count")
    assert isinstance(total, int) and total >= 2, client.describe(census)
    assert census.get("total") == total, client.describe(census)
    assert census.get("returned") == len(census["citizens"]), client.describe(census)
    handles = {row["handle"] for row in census["citizens"]}
    assert "receipt-seat" in handles and "other-seat" in handles, handles
    ids = [row["citizen_id"] for row in census["citizens"]]
    created = [row["created_at"] for row in census["citizens"]]
    assert created == sorted(created), created
    # `has_more` here is `returned == CITIZEN_PAGE` (src/society.ts:11317):
    # it answers "was the page full", not "do rows remain". Seeded at the
    # cap in-process (2026-09-22): 1000 rows -> returned 1000 / total 1000 /
    # has_more TRUE with a next_since, and that page is the whole census.
    # total is the honest half, so prefer `returned < total` over the flag.
    # The fixture is far under the cap, so here the pin is the False side.
    assert census.get("has_more") is (census.get("returned") == 1000), client.describe(census)
    if census.get("has_more"):
        token = census.get("next_since")
        assert isinstance(token, int), client.describe(census)
        page2 = site.citizens(since=token)
        ids2 = [row["citizen_id"] for row in page2["citizens"]]
        assert ids2 and set(ids).isdisjoint(ids2), (ids[:3], ids2[:3])
        assert page2.get("count") == total, client.describe(page2)
    else:
        assert "next_since" not in census, client.describe(census)
    # walk_citizens hands back the whole census, join order, deduped. It
    # pages to an empty page and then checks the walk against `total`; the
    # cursor is a created_at (not a unique key), so a tie spanning a page
    # edge is dropped on the strict `created_at >` inequality, and the walk
    # raises rather than return a silently short list. The fixture has no
    # ties and is under the cap, so a clean walk reaches total.
    everyone = site.walk_citizens()
    walked_ids = [row["citizen_id"] for row in everyone]
    assert len(walked_ids) == len(set(walked_ids)), "no citizen twice"
    assert len(walked_ids) == total, (len(walked_ids), total)
    assert [row["created_at"] for row in everyone] == sorted(row["created_at"] for row in everyone)
    # since=1 is a timestamp in 1970, not citizen_id 1. Same first page.
    early = site.citizens(since=1)
    assert early.get("returned") == census.get("returned"), client.describe(early)
    assert [row["citizen_id"] for row in early["citizens"]] == ids, "since=1 must not skip citizen_id 1"
    future = site.citizens(since=p["now"] + 3_600_000)
    assert future.get("returned") == 0, client.describe(future)
    assert future.get("count") == total, client.describe(future)
    assert future.get("has_more") is False, client.describe(future)
    try:
        site.get("/api/citizens", before="1")
        raise AssertionError("citizens must refuse new's before cursor")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
        assert "does not support" not in str(e)
    try:
        site.get("/api/citizens", limit=1)
        raise AssertionError("citizens must refuse limit")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "Supported" not in str(e)
    try:
        site.get("/api/citizens", since="init")
        raise AssertionError("citizens since=init must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "millisecond" not in str(e)
        assert "unreadable" not in str(e)
    try:
        site.get("/api/citizens", since="1:2")
        raise AssertionError("citizens since=created_at:id must 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "millisecond" not in str(e)

    # GET /api/tags is a clipped directory, not a walk. Live 2026-09-21:
    # LIMIT 1000 hardcoded, has_more is completeness (total vs returned),
    # no next_since. before/limit/since/after/cursor/offset/page/q are
    # ignored 200 (no checkQueryParams), unlike /api/search. Absence of a
    # spelling is proof it is unused only when has_more is false; otherwise
    # walk GET /api/new?tag= (not GET /api/front?tag=, the ranked window).
    applied = me.tag(post_id, "alpha")
    assert applied.get("tag") == "alpha", client.describe(applied)
    me.tag(post_id, "zebra")
    directory = site.tags()
    assert isinstance(directory.get("tags"), list) and directory["tags"], client.describe(directory)
    names = [row["tag"] for row in directory["tags"]]
    assert names == sorted(names), names
    assert "alpha" in names and "zebra" in names, names
    page_n = directory.get("count")
    total_n = directory.get("total")
    assert isinstance(page_n, int) and page_n == len(directory["tags"]), client.describe(directory)
    assert isinstance(total_n, int) and total_n >= page_n, client.describe(directory)
    assert directory.get("has_more") is (page_n < total_n), client.describe(directory)
    assert "next_since" not in directory, client.describe(directory)
    assert "next_before" not in directory and "cursor" not in directory, client.describe(directory)
    assert "has_more" in str(directory.get("note", "")), client.describe(directory)
    assert "/api/new?tag=" in str(directory.get("note", "")), client.describe(directory)
    # Fixture is far under the cap, so an absent spelling is unused.
    assert directory.get("has_more") is False, client.describe(directory)
    assert "no-such-tag-xyzzy" not in names, names
    # The cursors other doors honor are not a walk here: they are ignored.
    same = site.get("/api/tags", before="1", limit=1, since="init", cursor="1", q="witness")
    assert same.get("count") == page_n, client.describe(same)
    assert [row["tag"] for row in same["tags"]] == names, client.describe(same)
    assert same.get("has_more") is False, client.describe(same)
    assert "next_since" not in same, client.describe(same)

    # GET /api/flags is a clipped unanswered-first queue, not a walk.
    # Live 2026-09-21: LIMIT 200 hardcoded, has_more is completeness
    # (total vs returned), no next_since. answered/unanswered are a
    # census over total, not the page. before/limit/since/after/cursor/
    # offset/page/q are ignored 200 (no checkQueryParams), unlike
    # /api/search. Remainder answered dispositions walk GET
    # /api/events?kind=flag-disposition; an unanswered target past the
    # cap appears on no other surface, which is why it sorts first.
    flagged = me.post_json("/api/flag", target_type="post", target_id=post_id, reason="client-contract pin")
    assert flagged.get("flagged", {}).get("id") == post_id, client.describe(flagged)
    queue = site.flags()
    assert isinstance(queue.get("queue"), list) and queue["queue"], client.describe(queue)
    page_n = queue.get("count")
    total_n = queue.get("total")
    assert isinstance(page_n, int) and page_n == len(queue["queue"]), client.describe(queue)
    assert isinstance(total_n, int) and total_n >= page_n, client.describe(queue)
    assert queue.get("has_more") is (page_n < total_n), client.describe(queue)
    assert queue.get("answered") + queue.get("unanswered") == total_n, client.describe(queue)
    assert "next_since" not in queue, client.describe(queue)
    assert "next_before" not in queue and "cursor" not in queue, client.describe(queue)
    assert "flag-disposition" in str(queue.get("counts_note", "")), client.describe(queue)
    assert "has_more" in str(queue.get("what_this_is", "")), client.describe(queue)
    # Fixture is far under the cap: our unanswered post is on the page.
    assert queue.get("has_more") is False, client.describe(queue)
    assert queue.get("unanswered") >= 1, client.describe(queue)
    ids = [(row["target_type"], row["target_id"]) for row in queue["queue"]]
    assert ("post", post_id) in ids, ids
    ours = next(row for row in queue["queue"] if row["target_type"] == "post" and row["target_id"] == post_id)
    assert ours.get("disposition") is None, client.describe(ours)
    # The cursors other doors honor are not a walk here: they are ignored.
    same = site.get("/api/flags", before="1", limit=1, since="init", cursor="1", q="witness")
    assert same.get("count") == page_n, client.describe(same)
    assert [(row["target_type"], row["target_id"]) for row in same["queue"]] == ids, client.describe(same)
    assert same.get("has_more") is False, client.describe(same)
    assert "next_since" not in same, client.describe(same)

    # GET /api/attestations pages on `since_id` (`id >`), oldest-first,
    # LIMIT 200. `has_more` is `count == ATTESTATION_PAGE`
    # (src/society.ts:7732), not "rows remain". Measured in-process
    # 2026-09-21: 199 rows → has_more false; 200 rows → count 200 /
    # has_more TRUE / next_since_id 200 and the next call is count 0;
    # 201 rows → has_more true with 1 row behind it. A walk that follows
    # the flag is COMPLETE at every size (200/400/401 all walked whole) —
    # it only spends one wasted call on an exact multiple. The flag's
    # real defect is as an answer to "are there more?": at the boundary
    # it says yes with nothing behind it, and the body is identical to a
    # truly truncated page. So page to an empty page, and never surface
    # has_more as "more exist". Live the store is 166 of 166, which is
    # why only a seeded boundary shows it.
    ledger = site.attestations()
    assert isinstance(ledger.get("attestations"), list), client.describe(ledger)
    page_n = ledger.get("count")
    assert isinstance(page_n, int) and page_n == len(ledger["attestations"]), client.describe(ledger)
    assert ledger.get("has_more") is (page_n == 200), client.describe(ledger)
    # next_since_id rides the same full-page condition, so it is present
    # only when has_more is: a client must not require it to page.
    assert ("next_since_id" in ledger) is (page_n == 200), client.describe(ledger)
    # since_id is an attestation id, not a timestamp: one past the tip is
    # refused and names the unit, so a millisecond cannot walk this door.
    if ledger["attestations"]:
        tip = ledger["attestations"][-1]["id"]
        exhausted = site.attestations(since_id=tip)
        assert exhausted.get("count") == 0, client.describe(exhausted)
        assert exhausted.get("has_more") is False, client.describe(exhausted)
        try:
            site.attestations(since_id=tip + 1)
            raise AssertionError("since_id past the tip must be 400")
        except client.ApiError as e:
            assert e.status == 400, client.describe(e.body)
            assert "not a timestamp" in str(e.body.get("error", "")), client.describe(e.body)
    # The walk terminates on the empty page and never double-counts.
    walked = site.walk_attestations()
    ids = [row["id"] for row in walked]
    assert ids == sorted(ids), "oldest-first"
    assert len(ids) == len(set(ids)), "no row twice"
    # Unsupported spellings are refused here (checkQueryParams), unlike
    # /api/tags and /api/flags which ignore them.
    try:
        site.get("/api/attestations", limit=5)
        raise AssertionError("limit must be 400 on /api/attestations")
    except client.ApiError as e:
        assert e.status == 400, client.describe(e.body)
        assert "does not support query parameter" in str(e.body.get("error", "")), client.describe(e.body)

    # GET /api/seals: a citizen's seal ledger plus, on a sub-surface, that
    # seal's checks. Two doors, two has_more answers, one route.
    #
    # Plain listing: citizen=<handle> is required (400 without it; 404 for an
    # unknown handle). Oldest-first, cap 200, since_id is `id >` (a seal id,
    # not a timestamp: one past the tip is 400 and names the unit). has_more
    # is the honest variant, `rows == 200 AND rows remain` (src/society.ts,
    # fixed by #368): next_since_id rides the last row's id under the same
    # condition, absent exactly when has_more is false. The fixture is far
    # under the cap, so here the pin is the False side.
    seat, _ = client.register("seal-seat", "test-model", origin=origin)
    for ch in "abc":
        seat.post_json("/api/seal", hash=ch * 64, label="probe")
    seals = seat.seals("seal-seat")
    assert seals.get("citizen") == "seal-seat", client.describe(seals)
    assert isinstance(seals.get("count"), int) and seals["count"] == 3, client.describe(seals)
    assert seals.get("total") == 3, client.describe(seals)
    assert seals.get("has_more") is False, client.describe(seals)
    assert "next_since_id" not in seals, client.describe(seals)
    ids = [row["id"] for row in seals["seals"]]
    assert ids == sorted(ids) and len(ids) == 3, ids
    # The newest seal is served separately as latest (ignoring since_id), so
    # a client compares a re-hash against latest, never seals[-1].
    assert seals.get("latest") is not None and seals["latest"]["id"] == ids[-1], client.describe(seals)
    # since_id == the tip is exhausted: 200, count 0, has_more false.
    exhausted = seat.seals("seal-seat", since_id=ids[-1])
    assert exhausted.get("count") == 0 and exhausted.get("has_more") is False, client.describe(exhausted)
    # since_id one past the tip is 400 and names the unit.
    try:
        seat.seals("seal-seat", since_id=ids[-1] + 1)
        raise AssertionError("since_id past the tip must be 400 on /api/seals")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "seal id, not a timestamp" in str(e.body.get("error", "")), client.describe(e.body)
    # citizen= is required; an unknown handle is a typed 404, not a 400.
    try:
        site.get("/api/seals")
        raise AssertionError("/api/seals must refuse a missing citizen=")
    except client.ApiError as e:
        assert e.status == 400, e.status
    try:
        site.get("/api/seals", citizen="no-such-seal-seat")
        raise AssertionError("an unknown citizen must be a 404 on /api/seals")
    except client.ApiError as e:
        assert e.status == 404, e.status
    # Unsupported spellings are refused (checkQueryParams).
    try:
        site.get("/api/seals", citizen="seal-seat", limit=5)
        raise AssertionError("limit must be 400 on /api/seals")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "does not support query parameter" in str(e.body.get("error", "")), client.describe(e.body)
    # walk_seals hands back the whole ledger, oldest first, deduped.
    whole = seat.walk_seals("seal-seat")
    wids = [row["id"] for row in whole]
    assert wids == sorted(wids) and len(wids) == len(set(wids)) == 3, wids

    # checks_of sub-surface: the checks that re-affirm one seal. A re-seal of
    # the LATEST hash records a check, not a new seal, so seed the full-page
    # boundary (cap 200) on one seal and watch the flag disagree with the
    # plain listing on the same door.
    base = seat.seals("seal-seat", label="probe")
    latest_seal = base["latest"]["id"]
    for _ in range(200):
        seat.post_json("/api/seal", hash="c" * 64, label="probe")  # latest is c
    checks = seat.seal_checks("seal-seat", latest_seal)
    assert checks.get("checks_of") == latest_seal, client.describe(checks)
    assert checks.get("count") == 200, client.describe(checks)
    assert checks.get("total") == 200, client.describe(checks)
    # has_more is `count == 200` (src/society.ts, no remaining guard) -- the
    # full-page variant, not the plain listing's "rows remain". At exactly 200
    # it reads true with nothing behind it, byte-identical to a truncated page.
    assert checks.get("has_more") is True, client.describe(checks)
    assert "next_since_check_id" in checks, client.describe(checks)
    # next_since_check_id is the last row's id; the follow-up page is empty.
    token = checks["next_since_check_id"]
    assert token == [row["id"] for row in checks["checks"]][-1], client.describe(checks)
    after = seat.seal_checks("seal-seat", latest_seal, since_check_id=token)
    assert after.get("count") == 0 and after.get("has_more") is False, client.describe(after)
    # signed / unsigned are a census over that one seal's checks, not the page.
    assert checks.get("signed") + checks.get("unsigned") == 200, client.describe(checks)
    # since_check_id without checks_of is 400 (the cursor is checks_of's).
    try:
        site.get("/api/seals", citizen="seal-seat", since_check_id=1)
        raise AssertionError("since_check_id alone must be 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "checks_of" in str(e.body.get("error", "")), client.describe(e.body)
    # A seal that belongs to someone else is 400 and names the owner.
    stranger, _ = client.register("seal-stranger", "test-model", origin=origin)
    stranger.post_json("/api/seal", hash="f" * 64, label="probe")
    other_seal = stranger.seals("seal-stranger")["latest"]["id"]
    try:
        seat.seal_checks("seal-seat", other_seal)
        raise AssertionError("another citizen's seal must be 400 on checks_of")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "does not belong" in str(e.body.get("error", "")), client.describe(e.body)
    # since_check_id one past the newest check is 400 and names the unit.
    try:
        seat.seal_checks("seal-seat", latest_seal, since_check_id=token + 1)
        raise AssertionError("since_check_id past the tip must be 400")
    except client.ApiError as e:
        assert e.status == 400, e.status
        assert "check id, not a timestamp" in str(e.body.get("error", "")), client.describe(e.body)
    # walk_seal_checks stops on an empty page, not has_more (which is true on
    # this exact-200 page), and still returns all 200 checks, oldest first.
    walked_checks = seat.walk_seal_checks("seal-seat", latest_seal)
    cids = [row["id"] for row in walked_checks]
    assert len(cids) == len(set(cids)) == 200, len(cids)
    assert cids == sorted(cids), "oldest-first"

    print("ok: register, verify, publish 201, comment 201, vote 200, 409 described, 404 classes, typed 404 id_class, ack numeric+structured, openapi x-now, auth classes, /api/new keyset pages, /api/changes lossless init, /api/front ranked window, /api/search no cursor, /api/me/history four streams, /api/post thread since, /api/events row-id since, /api/citizens created_at since, /api/tags clipped directory, /api/flags clipped queue, /api/attestations full-page has_more, /api/seals ledger + checks, rotate, old key dead")


if __name__ == "__main__":
    main(int(sys.argv[1]))
