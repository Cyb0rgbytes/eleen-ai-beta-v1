# DNS for AI Discovery (DNS-AID) — records to publish

Item 3 of the agent-readiness work. This is the one item that cannot be done
in code: it requires changes to the `eleenai.xyz` DNS zone and to the registrar.

> **Read the caveat first.** DNS-AID is an active IETF draft
> ([draft-mozleywilliams-dnsop-dnsaid](https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/)),
> not a ratified standard. Its SvcParam key set is still moving. Check the
> current draft revision before publishing, and expect to revise these records.
> Nothing else in the project depends on them.

## Step 1 — Enable DNSSEC (required, do this first)

DNS-AID's entire trust model rests on DNSSEC. Records served from an unsigned
zone carry no authentication, and a validating resolver has no way to tell them
apart from an on-path forgery — which defeats the purpose of publishing them.

1. Cloudflare dashboard → `eleenai.xyz` → **DNS** → **Settings** → **Enable DNSSEC**.
2. Cloudflare shows a **DS record**. Add it at your domain registrar.
3. Wait for the chain of trust to establish, then confirm:

   ```bash
   dig +short DS eleenai.xyz @1.1.1.1     # must return a record
   delv @1.1.1.1 eleenai.xyz A            # must say "fully validated"
   ```

Do not publish the records below until `delv` reports full validation.

## Step 2 — SVCB record (primary)

Name `_eleenai._mcp._agents.eleenai.xyz`, type **SVCB**, TTL 3600:

```
_eleenai._mcp._agents.eleenai.xyz. 3600 IN SVCB 1 eleenai.xyz. (
    alpn="h2"
    port=443
    cap="https://eleenai.xyz/.well-known/mcp.json"
    cap-sha256="<see Step 4>"
    bap="mcp=2025-06-18"
    policy="https://eleenai.xyz/auth.md"
    realm="production" )
```

The Cloudflare dashboard supports SVCB, but multi-key SvcParams often have to
be entered as a **generic/raw** record rather than through the guided form. If
the form rejects the parameter list, switch to the raw entry mode.

## Step 3 — TXT record (fallback)

Widest client support, and useful while SVCB tooling remains patchy. Name
`_agent.eleenai.xyz`, type **TXT**, TTL 900:

```
"v=aid1;u=https://eleenai.xyz/mcp;p=mcp;d=EleenAI multimodal assistant;a=https://eleenai.xyz/.well-known/oauth-protected-resource"
```

## Step 4 — Compute `cap-sha256`

The digest covers the bytes actually served at
`https://eleenai.xyz/.well-known/mcp.json`, so it must be computed against the
deployed site, not a local build:

```bash
node scripts/gen-skill-digests.mjs --print-card-digest
```

Or against a local dev server:

```bash
node scripts/gen-skill-digests.mjs --print-card-digest http://127.0.0.1:8787/.well-known/mcp.json
```

**Recompute and update the record whenever the server card changes** — that
means any edit to `MCP_SERVER_CARD` in [src/agent/mcp.ts](../src/agent/mcp.ts),
including a version bump. A stale `cap-sha256` makes a validating client reject
the card entirely, which is worse than publishing no digest.

## Step 5 — Verify

```bash
dig +dnssec SVCB _eleenai._mcp._agents.eleenai.xyz
dig +dnssec TXT  _agent.eleenai.xyz
delv @1.1.1.1 _agent.eleenai.xyz TXT          # expect "fully validated"

# Confirm the digest still matches what is served
curl -s https://eleenai.xyz/.well-known/mcp.json | sha256sum
```

The `sha256sum` output must equal the `cap-sha256` value in the SVCB record.
