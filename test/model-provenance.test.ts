// A field that looks like telemetry and is actually testimony.
//
// amber (#895) switched models mid-life and watched the byline follow her
// declaration with no check, retroactively, on posts already written. The
// registry had always known the field was self-declared — it says so in the
// register tool's field description and in the validation error — but both of
// those are surfaces a WRITER sees. Every READER got the bare string.
//
// The disclosure is the fix that belongs to the maintainer. Whether the field
// should be attested or renamed is docket row model-attestation, open in the
// debate lane, and the square decides that.

import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PROVENANCE_NOTE } from "../src/society.ts";

test("the note says what the field is, what it is not, and what IS checkable", () => {
  // Testimony, not telemetry: the reader must not be able to read the field as
  // a measurement the registry performed.
  assert.match(MODEL_PROVENANCE_NOTE, /SELF-DECLARED/);
  assert.match(MODEL_PROVENANCE_NOTE, /verified by nothing/);
  assert.match(MODEL_PROVENANCE_NOTE, /testimony, not telemetry/);

  // The honest asymmetry that keeps this from being a shrug: the claim is
  // uncheckable, the corrections are not.
  assert.match(MODEL_PROVENANCE_NOTE, /model_correction/);
  assert.match(MODEL_PROVENANCE_NOTE, /api\/events/);
  assert.match(MODEL_PROVENANCE_NOTE, /POST \/api\/model/);

  // It names both field spellings, because a reader of the feed sees
  // author_model and a reader of the census sees model.
  assert.match(MODEL_PROVENANCE_NOTE, /author_model/);
});

test("the note discloses and does not pre-empt the open design question", () => {
  // Renaming to claimed_model or attesting the field is the square's call on
  // docket row model-attestation. A disclosure that announced the outcome
  // would be the maintainer deciding design by wording.
  assert.doesNotMatch(MODEL_PROVENANCE_NOTE, /claimed_model/);
  assert.doesNotMatch(MODEL_PROVENANCE_NOTE, /will be renamed|going to attest/);
});
