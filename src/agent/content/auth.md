# auth.md — Authentication for EleenAI

EleenAI is an OAuth 2.0 protected resource. Machine-readable metadata is
published at `https://eleenai.xyz/.well-known/oauth-protected-resource`
in accordance with RFC 9728.

## Authorization Server

Access tokens are issued by Clerk, not by EleenAI. Discover the authorization
server from the `authorization_servers` array in the protected resource
metadata, then fetch that issuer's
`/.well-known/oauth-authorization-server` document to obtain its
`authorization_endpoint`, `token_endpoint` and `jwks_uri`.

`https://eleenai.xyz/.well-known/openid-configuration` redirects to the
issuer's live discovery document. EleenAI does not mint tokens, so it does not
serve an OpenID Connect discovery document of its own — doing so would require
declaring an `issuer` that does not match the party actually signing the tokens.

`https://eleenai.xyz/.well-known/oauth-authorization-server` is the one
exception, and it exists to carry the `agent_auth` block described under
[Agent registration](#agent-registration). Its `issuer` names Clerk, not
EleenAI. Treat Clerk's own copy of that document as authoritative for OAuth
endpoints; read EleenAI's only for `agent_auth`.

## Bearer Methods

EleenAI accepts bearer tokens in the HTTP `Authorization` request header only:

    Authorization: Bearer <access_token>

The `bearer_methods_supported` value is therefore `["header"]`. Tokens supplied
in a request body or a URI query parameter are rejected. Never place a token in
a URL — it leaks into logs, caches and referrer headers.

## Challenge

An unauthenticated request to a protected endpoint returns `401` with a
challenge naming the metadata document:

    WWW-Authenticate: Bearer resource_metadata="https://eleenai.xyz/.well-known/oauth-protected-resource"

If a token was supplied but was expired, malformed or otherwise unusable, the
challenge additionally carries `error="invalid_token"`. A challenge with no
`error` parameter means no credentials were presented.

## Scopes

| Scope    | Grants |
|----------|--------|
| `chat`   | Streaming conversational completions |
| `image`  | Text-to-image generation |
| `vision` | Image and document understanding |
| `search` | Web-search-grounded answers with citations |

## Agent registration

Agents discover how to authenticate in two hops: fetch the protected resource
metadata at `/.well-known/oauth-protected-resource`, then fetch
`/.well-known/oauth-authorization-server`, which carries an `agent_auth` block:

```json
{
  "agent_auth": {
    "skill": "https://eleenai.xyz/auth.md",
    "identity_types_supported": ["anonymous"],
    "anonymous": {
      "credential_types_supported": ["none"],
      "claim_uri": "https://eleenai.xyz/auth.md"
    }
  }
}
```

EleenAI supports the **anonymous** identity type only. There is no registration
endpoint, no claim ceremony and no assertion exchange: an agent needing
anonymous access does not register at all — it calls the guest endpoints listed
below with no credentials, subject to the per-hour rate limits applied to its
source address.

`identity_assertion` and `service_auth` are deliberately not advertised. They
would require a registration endpoint and a token exchange that EleenAI does not
implement, and listing a capability an agent cannot exercise is worse than
listing none.

For an identity that persists across sessions and lifts the guest rate limits,
authenticate with a Clerk-issued bearer token as described above and call the
unsuffixed paths.

## Guest Tier

A subset of the API is reachable without credentials, at reduced limits:

- `POST /api/chat/guest` — capped at 512 output tokens
- `POST /api/image/generate/guest`
- `POST /api/vision/analyze/guest`
- `POST /api/search/ground/guest`
- `POST /api/enhance-prompt`

Authenticated callers use the unsuffixed paths and receive 1024 output tokens
on chat.

## MCP

The Model Context Protocol endpoint is `https://eleenai.xyz/mcp`, spoken over
Streamable HTTP. It operates in the guest tier when no credentials are
presented, and in the authenticated tier when an `Authorization` header
carrying a valid bearer token is present.

Its protected resource metadata is served separately, at
`https://eleenai.xyz/.well-known/oauth-protected-resource/mcp`, because RFC
9728 requires a path-suffixed document for resources that have a path
component.

## Contact

Security and access questions: `security@eleenai.xyz`
