# Identity assertion operations

This is a proposed operating procedure, not approval to activate issuance.
The upstream human maintainer must approve the key custodian, authorized
Cloudflare account operators, generation environment, backup policy, rotation
owner, and incident contact before provisioning the signing secret. No such
production decisions are claimed by this contribution. Leave the variables
empty and the secret unset until those decisions are recorded.

## Custody and activation

Use a dedicated Ed25519 key for identity assertions, never a citizen key,
registry checkpoint key, wallet key, or OAuth key. Generate it with a
cryptographic key generator in the maintainer-approved private environment.
The secret is the base64url encoding of the raw 32-byte seed, without padding;
the matching public key is the base64url encoding of 32 public-key bytes.
Neither is a PEM string or an arbitrary password.

Store the seed only as the encrypted Worker secret `IDENTITY_ASSERTION_SEED`
through the approved Cloudflare secret provisioning flow (for example,
`wrangler secret put IDENTITY_ASSERTION_SEED` with private input). Do not put
it in a plain variable, source file, PR, shell argument, terminal transcript,
or CI log. If a recovery copy is approved, retain it only in the custodian's
restricted secret store. Restrict account/deployment access to the approved
operators: a principal who can deploy Worker code can arrange to use or
exfiltrate its runtime secrets. Encryption at rest does not remove that trust.

Publish only the public half as `IDENTITY_ASSERTION_PUBLIC_KEY`. Additional
public keys are comma-separated in `IDENTITY_ASSERTION_PREVIOUS_PUBLIC_KEYS`;
despite its name this list may temporarily include a *next* key to prepublish
it before a rotation. Every listed key is trusted for verification, so never
prepublish a key whose custody has not been approved.

Before activation, read back the metadata and JWKS through the public issuer,
check the expected key and `kid`, and verify a test assertion's signature,
issuer, audience, nonce, expiry and unique id through the approved full door.
Never send the citizen secret to a relying project. Missing/malformed public
configuration returns 503 for discovery; absent/malformed/mismatched seed
returns 503 for issuance. The signer checks its seed against the published
public key before minting. These checks fail closed but are not a substitute
for approval or a successful deployment readback.

## Planned rotation

1. Generate the next dedicated key under the same approved custody procedure.
   Keep signing with the current pair while publishing the next public key in
   the additional-key list. Read the public JWKS back before using that key.
2. Stop issuance by removing the signing secret using the approved provisioning
   flow. Publish the next public key as current and the old public key in the
   additional-key list. Install the matching new seed privately. These updates
   need not be atomic: absent or mismatched pairs must return 503, not mint
   tokens under an unpublished key. Keep both public keys through deployment
   propagation and the availability interruption. Do not restore a configuration
   that drops a key still signing on an older Worker version.
3. Verify a newly issued token against the public JWKS and verify an unexpired
   old token against its retained key. Record when the old key last issued a
   token, including any rollback or old-version traffic. Retain its public key
   for at least 300 seconds after that last issuance, plus the clock tolerance
   relying parties accept. If the last issuance time or propagation is uncertain,
   retain it longer. JWKS responses specify `Cache-Control: no-store`.
4. Only then remove the retired public key. Retire the old seed according to
   the approved backup policy. Rollbacks must preserve every public key still
   needed by a live token; a code rollback is not permission to restore stale
   key variables.

## Verifier failure and recovery

Pin the issuer and fetch only its configured HTTPS `jwks_uri`; never follow a
JWT's `jku`/`x5u` or accept an embedded key as issuer authority. Require EdDSA
with the matching Ed25519 key and exact expected issuer, normalized audience,
and challenge nonce, a live expiry, and one-time consumption of nonce and
`jti`. Consume them atomically after all cryptographic and claim checks pass.

If a live token's `kid` is missing, refresh the configured JWKS once, bypassing
local caches. If the key remains absent, retrieval fails, or signature
verification fails, reject the assertion and grant no access. Do not guess a
key, extend expiry, accept decoded claims, or ask for the citizen secret as a
fallback. This is an issuer availability/rotation failure. Once repaired,
restart with a fresh challenge nonce and token. There is no cursor or replay
mechanism that makes an unverifiable token valid.

## Compromise and outage

Stop issuance, remove the compromised public key without the normal overlap,
and notify relying parties through the maintainer's incident channel. Restore
only a newly generated approved pair and read it back. Emergency key removal
intentionally invalidates live tokens using that key. Cached keys may still
verify tokens until expiry (plus a verifier's clock tolerance), so immediate
global revocation is not promised. Issuance is stateless: there is no per-token
revocation table, and the registry cannot enforce a relying party's nonce or
`jti` replay store. Availability and key continuity require operations; neither
the JWKS nor this proposal promises uninterrupted service.

## MCP boundary

`identity_assertion` is served only on full `/mcp`. It uses the Worker's private
key to mint a credential, even though it changes no database rows. `/mcp/read`
and `/mcp/protocol` omit it and refuse direct calls before authentication or
signing. Its HTTP twin is classified as a credential-issuing write in the
surface and agentic-access contract. This credential proves citizenship
control at issuance only: no external permission, reputation endorsement, or
proof of control of a separately bound self-custodied key.
