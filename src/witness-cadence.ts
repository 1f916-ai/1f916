// What may be said about how often the GitHub witness runs, in one place.
//
// The registry used to start the witness itself: from 2026-08-12 its cron
// fired a workflow_dispatch on every five-minute tick. It stopped on
// 2026-09-29. A job started on a timer by a running service is not what
// GitHub's terms for Actions allow, so the trigger was removed from the
// scheduled handler and the token it used was deleted. What is left is the
// workflow's own schedule, which GitHub runs or does not.
//
// Every served sentence about the witness's cadence is built from these, so
// that the next change of fact is made once. Each is either a schedule (what
// is asked for, never what was achieved) or a dated observation that says of
// itself that it is dated. Nothing here can know whether GitHub ran the job:
// this Worker no longer speaks to GitHub at all.
//
// This module imports nothing, so anything may import it.

export const WITNESS_TRIGGER_FROM = "2026-08-12T03:41Z";
// The last dispatch the registry attempted, from witness_dispatch.last_attempt_at.
export const WITNESS_TRIGGER_LAST = "2026-09-29T01:46:21Z";
// The `at` of the last head line before the gap, and the first head line
// after it. The witness went quiet after WITNESS_LAST_LINE and resumed at
// WITNESS_RESUMED; the two countersignature lines of each run follow its head
// by a second. These two bracket a known gap in the log and do not move as the
// witness runs on; WITNESS_RESUMED is the first head of its own day file.
export const WITNESS_LAST_LINE = "2026-09-28T16:26:28Z";
export const WITNESS_RESUMED = "2026-10-08T19:52:35Z";
export const WITNESS_STANDING_WRITTEN = "2026-09-29";
export const WITNESS_RESUMED_WRITTEN = "2026-10-08";

// The workflow file still declares workflow_dispatch, so a run can be started
// by hand. What ended is the registry starting it; the sentence says that and
// no more.
export const WITNESS_SCHEDULE = "scheduled hourly by GitHub's own scheduler; the registry does not start it, and a run can still be started by hand by whoever holds write access to the repository";

export const WITNESS_CADENCE = `It is ${WITNESS_SCHEDULE}. From ${WITNESS_TRIGGER_FROM} until ${WITNESS_TRIGGER_LAST} the registry's cron also attempted a dispatch every five minutes; it no longer does`;

export const WITNESS_STANDING = `Written ${WITNESS_STANDING_WRITTEN}: the witness log went quiet after ${WITNESS_LAST_LINE}, and from that run until this was written the job did not run and the repository was not publicly readable. Updated ${WITNESS_RESUMED_WRITTEN}: the witness has resumed, its first head line after the gap at ${WITNESS_RESUMED}. Each clause is dated; the day files' own timestamps are the record`;

export const WITNESS_TRIGGER_RETIRED_NOTE = `the registry no longer triggers the witness. Its last attempt was ${WITNESS_TRIGGER_LAST}; the fields beside this note are that attempt and the last one GitHub accepted, kept as history, and they will not move again. The witness is ${WITNESS_SCHEDULE}. The day file's own \`at\` timestamps are the record of when it ran`;

export const WITNESS_TRIGGER_NEVER_NOTE = `the registry does not trigger the witness, and this deployment holds no record of ever having done so. The witness is ${WITNESS_SCHEDULE}. The day file's own \`at\` timestamps are the record of when it ran`;
