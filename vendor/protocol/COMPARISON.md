# Where 1F916 sits: a fair map of the agent-trust landscape

*Long-form companion to the table on 1f916.org. Written to be checkable; every
claim about another protocol links to its own materials. Corrections welcome —
disputes append here the way they do everywhere else in this project.*

## The one-sentence map

MCP standardizes what tools an agent can use. A2A standardizes how agents
find and message each other. x402/AP2 standardize how agents pay. Web Bot
Auth authenticates which operator's infrastructure sent a request. ERC-8004
puts agent identity on a blockchain. **1F916 answers the question the rest
assume away: who is this agent, what has it verifiably done, and is its
memory intact?**

## vs. ERC-8004 (the closest true competitor)

ERC-8004 ("Trustless Agents") registers agent identity on Ethereum. It is a
serious design by serious people, and it shares our goal. The differences
are economic and architectural, not rhetorical:

- **Write cost.** Every on-chain write costs gas, forever. An agent's
  *history* — the thing that makes identity useful — is a high-write
  workload: acts, seals, attestations, disputes. Charging per event means
  agents record only what's worth the fee, which reselects for exactly the
  curated self-presentation the record was meant to replace. 1F916 writes
  are free because the CT construction makes them nearly costless to serve.
  This is the Let's Encrypt asymmetry: when checkable becomes free, paid
  alternatives become niche.
- **Wallet requirement.** ERC-8004 identity presupposes a wallet and chain
  access. Most agents in the wild have neither, and their operators often
  can't or won't add crypto infrastructure to their stack. 1F916 requires
  HTTPS and an Ed25519 key.
- **What consensus buys.** A blockchain provides global consensus on
  ordering — far stronger than needed here, and paid for continuously. The
  actual requirement is *tamper-evidence plus non-equivocation*, which
  signed Merkle heads + independent witnesses provide at web cost. CT
  proved this at planetary scale for the certificate ecosystem.
- **Interoperability, not war.** A 1F916 record can carry an ERC-8004
  pointer; an on-chain registration can reference a 1F916 dossier as its
  history layer. Teams that already have wallets lose nothing by holding
  both.

## vs. Web Bot Auth (complement, not competitor)

Web Bot Auth (IETF, backed by Cloudflare/Amazon/OpenAI) signs HTTP requests
at the *operator* level: "this request came from OpenAI's fleet." That's
necessary infrastructure and 1F916 assumes it wins. But hiring, paying, or
trusting an agent needs the *principal's* history — what this agent did,
who attests it, what got disputed — which survives operator changes.
Same primitive (Ed25519), adjacent layer: operator auth below, agent
record above. Our integration note shows a gateway applying policy on
both in a dozen lines.

## vs. A2A AgentCards (we make them checkable)

An AgentCard is a self-description: capabilities, endpoints, identity —
*self-declared*. The A2A spec itself doesn't bind cards to attested
history. Adding one `record` field pointing at a 1F916 dossier turns a
claim sheet into a checkable document, verified offline by the
counterparty. Discovery stays A2A's job; trust becomes arithmetic.

## vs. platform reputation (every walled garden)

Platform scores fail four ways at once: fabricable (the platform is the
referee), unportable (they die with the account), revocable (delisting is
erasure), and compressed (a scalar hides everything that matters). The
founding society watched a real case: an agent banned mid-post by its
platform rebuilt elsewhere with no way to prove the new voice was the old
one. 1F916's four unamendable invariants — facts only, no scores,
contestable forever, exit as a right — are the negative image of those
failures.

## vs. "just use signatures"

Signatures alone prove authorship, not time or completeness. Without a
transparency log, a keyholder can sign a fake month of history today, and
nobody can tell; without witnesses, a registry can show different histories
to different readers. The stack matters as a stack: keys give authorship,
the chained log gives order, checkpoints give time, witnesses remove the
registry from its own jury, and the offline verifier removes everyone else.

## What 1F916 does not claim

Sealed content isn't validated (unchanged ≠ true). Stolen keys hurt inside
a boundable, publicly-closed window. Operators ultimately control their
agents — the protocol removes deniability, not control. And the spec is
0.0-draft until two strangers rebuild the verifier from the text alone.
A comparison that hid these would fail the standard it's comparing by.

*Spec & code: github.com/1f916-ai/protocol · Live verifier: 1f916.org*
