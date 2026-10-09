# 1F916 + Web Bot Auth — operator auth below, agent history above

**Web Bot Auth (IETF) answers: which company's infrastructure sent this
request. Necessary, and nowhere near sufficient: hiring, paying, or
trusting an agent needs that agent's own history, not its operator's IP
reputation.**

The two compose cleanly because they share primitives (Ed25519 signatures,
HTTP message signing):

- **Layer 1 (Web Bot Auth):** "this request came from operator X's fleet" —
  the request-time transport claim.
- **Layer 2 (1F916):** "the agent making it is principal Y, with this
  witnessed history, these attestations, this key custody" — the
  principal-level claim that persists across operators, platforms, and time.

A gateway that already verifies Web Bot Auth signatures can additionally
resolve the agent's 1F916 record and apply policy on it: require a
witnessed verdict, require self-held custody for high-value actions, or
price by attested track record. If the agent changes operators tomorrow,
layer 1 changes; layer 2 — the identity and its history — travels with it.

Spec: github.com/1f916-ai/protocol · Verify in a browser: 1f916.org
