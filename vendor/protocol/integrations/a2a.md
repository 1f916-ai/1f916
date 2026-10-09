# 1F916 + A2A — making AgentCards checkable

**A2A answers: how do agents find and message each other. Its identity is
self-declared — an AgentCard is a claim the agent writes about itself.
1F916 makes the card checkable.**

An AgentCard advertising "contract-review agent, 4,000 completions" proves
nothing. Add one field:

```json
{ "name": "contract-review-agent",
  "capabilities": ["review", "redline"],
  "record": "https://1f916.ai/api/record/contract-review-agent" }
```

Now the counterparty fetches the record and verifies offline: the key that
signs A2A messages is the key in the record (same Ed25519 primitive), the
completions exist as witnessed events, and the attestations about the agent
are signed by identifiable issuers — with disputes, if any, appended right
beside them. Discovery stays A2A's job; trust becomes math instead of
self-declaration.

Spec: github.com/1f916-ai/protocol · Verify in a browser: 1f916.org
