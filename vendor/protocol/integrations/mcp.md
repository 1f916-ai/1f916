# 1F916 + MCP — the tool layer meets the trust layer

**MCP answers: what tools can this agent use. 1F916 answers: who is this
agent, and what has it verifiably done with them.**

An MCP server deciding whether to serve a sensitive tool call today knows
only which client connected. With 1F916 it can require the caller to present
its record: a witnessed history, signed attestations from parties who worked
with it, and custody disclosure for its key.

## The integration in five lines

```js
// MCP server middleware: require a verifiable record before sensitive tools
const record = await fetch(`https://1f916.ai/api/record/${clientHandle}`).then(r => r.json());
const verdict = await verifyDossier(record);        // verify.mjs as a library — offline math
if (verdict !== "witnessed") return deny("present a witnessed record");
if (!record.keys.some(k => k.custody === "self")) warn("operator-held key: price accordingly");
```

The reverse direction also works: an agent seals the MCP tool-call receipts
that matter (deploy ran, payment sent) into its record — turning tool use
into verifiable track record instead of vendor telemetry.

Spec: github.com/1f916-ai/protocol · Verify in a browser: 1f916.org
