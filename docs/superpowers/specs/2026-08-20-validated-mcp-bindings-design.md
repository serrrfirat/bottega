# Design: validated MCP bindings (issue #286)

- Status: approved (verified-hybrid design)
- Issue: [#286 — Validate hosted MCP bindings instead of guessing vendor endpoint conventions](https://github.com/serrrfirat/bottega/issues/286)
- Date: 2026-08-20
- Scope: `src/extensions/catalog-register.ts`, `src/tools/admin.ts` (pin gate), `src/extensions/manifest.ts` (HTTPS-only binding validation), caller-level tests; plus the Gmail snapshot re-pin (documented migration, performed separately)

## 1. Problem and premise correction

Hosted MCP bindings are **synthesized, never probed**. Two independent paths share this root cause:

1. **Deterministic catalog connect** — `discoverCatalogMcp` (`src/extensions/catalog-register.ts:102-147`) derives `host = entry.domain.startsWith("mcp.") ? entry.domain : "mcp."+entry.domain` and `serverUrl = "https://"+host+"/mcp"` (lines 103-104), then probes only two RFC 8414 well-known paths (lines 109-112) to classify *auth mode* (oauth vs api_key). The MCP endpoint itself is never contacted: no `initialize`, no `tools/list`, no status check. A 404 on the endpoint is invisible; `lookupCatalogExtension` (lines 228-306) persists the synthesized URL verbatim into the manifest.
2. **Manual pin** — `catalog_browser action=pin` (`src/tools/admin.ts:863-1013`) merges `params.binding`, runs shape-only `validateManifest`, merges the host into `domains` via `hostedBindingHost` (`admin.ts:328-341`), waits for the human's `confirm`, then writes the snapshot. Zero wire probes in the entire flow. This is the path that produced the broken Gmail snapshot.

**Premise correction.** The issue's earlier Slack diagnosis referenced `OAUTH_TOKEN_ENDPOINTS` (`src/egress/generate.ts`); that map no longer exists since #284 — the official MCP SDK owns all OAuth (RFC 8414 discovery, dynamic client registration, PKCE, refresh) and the egress proxy never mints. Adding a Google token endpoint would **not** fix the Gmail 404 binding. The real gap is endpoint validation: there is no universal vendor-host/path convention (`linear.app → mcp.linear.app/mcp` works; `gmail.googleapis.com → gmailmcp.googleapis.com/mcp/v1` does not — even the deterministic path would have synthesized the wrong `mcp.gmail.googleapis.com`), and the code can register/pin an endpoint it never proved speaks MCP. Fix = protocol-level endpoint validation that fails closed, with explicit endpoint metadata and a reviewed override as the trusted sources.

## 2. Goals and non-goals

### Goals

- Never pin or register a synthesized endpoint unless a protocol-level probe proves it is an MCP endpoint or returns a standards-compliant OAuth challenge.
- Prefer explicit endpoint metadata when a trusted catalog supplies it (inert today — the live catalog carries none, but the field is load-bearing for forward compatibility).
- Support a reviewed/manual endpoint override for providers whose catalog only links documentation (this is the Gmail path).
- Keep OAuth authorization-server and token-endpoint discovery 100% inside the official MCP SDK. No provider-specific token endpoint maps; no proxy OAuth minting.
- Preserve egress allowlisting from the **validated** MCP binding host.
- Repair/re-pin Gmail with its official `https://gmailmcp.googleapis.com/mcp/v1` binding after the generic path exists.

### Non-goals

- **No boot-time re-probing of existing pinned snapshots.** The probe gates only *new* registrations and pins. A cheap optional `--validate-snapshots` CLI that re-probes pinned hosted snapshots is a follow-up, not part of this change.
- **No SSE-transport probe support.** A 202/SSE-only initialize response is classified `rejected` (fail closed) — see §4. An SSE-only server is unpinnable until SSE probe support is added; Google's endpoint responds 200 + JSON, so it is unaffected.
- **No changes to `mcp-oauth.ts`** (SDK-owned OAuth flow), no changes to stdio/CLI bindings, no new dependencies.
- **No changes to the RFC 8414 auth-classification probe** (`discoverCatalogMcp`'s well-known checks). It remains the oauth-vs-api_key signal when the endpoint probe returns `mcp`.

## 3. Candidate generation (finite, ordered, conservative)

The candidate set is **finite and strictly ordered**. A candidate is *used* only if the probe (§4) accepts it; otherwise the next candidate is tried; when the set is exhausted the operation fails closed with an actionable message (§8). The order encodes trust:

| Priority | Candidate | Source | Notes |
|---|---|---|---|
| 1 | **Trusted explicit endpoint metadata** — `CatalogEntry.mcpEndpoint` (new optional field) | Catalog record, honored verbatim | Machine-readable, vendor-published. Wins over all derivation. Today the integrations.sh catalog carries no such field (`CatalogEntry` is id/slug/name/kind/domain + optional url/description, `src/extensions/fetch-catalog.ts:140-162`), so this is inert until the catalog publishes it. |
| 2 | **Exact reviewed override** — `binding.serverUrl` supplied via `catalog_browser action=pin` (`admin.ts`) or a hand-edited draft via `fetch-catalog.ts --pin` | Human/vendor-doc review (the `confirm` gate records `source.reviewed: true`) | Probed verbatim before the review gate. This is the only path Gmail's `gmailmcp.googleapis.com/mcp/v1` can enter (the live catalog dropped the gmail entry entirely in the 2026-08-20T15:47:56Z regen — §7). |
| 3 | **Derived candidates** — `https://mcp.<domain>/mcp`, then `https://mcp.<domain>/mcp/v1` (same host, two paths) | Synthesized from `entry.domain` | Used **only when no explicit endpoint exists** (catalog connect path, `discoverCatalogMcp`). Existing `mcp.`-prefix guard stays (never double-prefix a domain that is already `mcp.<...>`, `catalog-register.ts:103`). |

**Never derive vendor-specific hosts by concatenating prefixes.** `gmailmcp` from `gmail`, `gmailmcp.googleapis.com` from `gmail.googleapis.com`, or any other ad-hoc host synthesis is prohibited — such facts are exactly what a reviewed override (priority 2) is for. The two derived candidates differ only in **path**, never in host, and both are probed in order; the first accepting verdict wins.

## 4. The endpoint probe

New `probeMcpEndpoint(serverUrl: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<ProbeVerdict>` in `src/extensions/catalog-register.ts` (or a tiny sibling module). It reuses the already-pinned **MCP SDK 1.30.0** — no new dependency — and the existing injected-`fetchImpl` seam (`FetchCatalogOptions.fetchImpl`), so it is fully hermetic in tests.

**Wire shape** — a raw POST JSON-RPC `initialize` (not a full `Client`/transport/session, which would add session state and another failure surface):

- Method `POST`, headers: `content-type: application/json`, `accept: application/json, text/event-stream`, `MCP-Protocol-Version: <LATEST_PROTOCOL_VERSION>`.
- Body: `{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "bottega-probe", version: "1" } } }`.
- `LATEST_PROTOCOL_VERSION` from `@modelcontextprotocol/sdk/types.js` (exported const, `'2025-11-25'`).
- Wall-clock bound: `MCP_DISCOVERY_TIMEOUT_MS = 10_000` (reuse the constant at `src/extensions/generate-tools.ts:240`; overridable for hermetic tests).
- No credentials are ever sent, nothing is minted, no OAuth client is registered — the probe is pre-authorization by construction.

**Verdicts** (union `{ ok: true; kind: "mcp" | "oauth_challenge"; evidence } | { ok: false; rejected: true; evidence }`):

| Verdict | Accepted proof | Classification |
|---|---|---|
| `mcp` | HTTP 200 + JSON body whose `result` parses the SDK's exported `InitializeResultSchema` (supported `protocolVersion` + required `capabilities`; `types.js:539`) — the same validation `Client.connect` runs (`client/index.js:276-310`) | Definitive MCP endpoint. Register as today; auth classification unchanged (RFC 8414 well-known probe on the validated origin; §6). |
| `oauth_challenge` | HTTP 401, or 403 with `error="insufficient_scope"`, plus a `WWW-Authenticate: Bearer ...` challenge parsed by the SDK's exported `extractWWWAuthenticateParams` (`client/auth.js:348-373`) — a valid single Bearer scheme with optional `resource_metadata`/`scope`/`error` (RFC 6750) | Endpoint exists and is OAuth-gated. `credentialSchema: { type: "oauth" }`, `oauthGated: true` → tools-less manifest (the #231 notion pattern; runtime discovers the surface at boot). |
| `rejected` | Everything else — fail closed: 404/405/other 4xx/5xx without a Bearer challenge; 401 without `WWW-Authenticate`, with a non-Bearer scheme, or with malformed/duplicate challenges; 200 with non-JSON/SSE content (HTML landing page); 202/SSE-only (inconclusive → rejected, per non-goals); timeout; network error; redirect; non-`https:` URL | Nothing is registered or pinned. The evidence string feeds the actionable message (§8). |

`DiscoveredCatalogMcp.host` becomes `new URL(validatedServerUrl).host` — the host of the **validated** URL, so the egress allowlist follows the proven endpoint (acceptance: "Preserve egress allowlisting from the validated MCP binding host").

## 5. HTTPS, redirect, and host security (issue #286 Security)

- **HTTPS-only.** The probe refuses any non-`https:` URL outright. This closes the shape-only gap where `validateMcpBinding` accepts `http:` (`src/extensions/manifest.ts:283-285`) for every endpoint that passes the probe path. (Manifest validation itself is unchanged — the probe is the gate.)
- **Redirects never followed.** The probe fetches with `redirect: "error"`. A redirect cannot smuggle egress to an arbitrary host, and a 3xx is a `rejected` verdict.
- **Allowlist host = final validated URL's host**, `new URL(serverUrl).host` — never a redirect target, never a well-known metadata origin. This matches the SDK's own `checkResourceAllowed` semantics (same-origin + path-prefix for RFC 8707 resources).
- **Domains merge is unchanged and safe**: scaffold domain + validated host, deduped (`catalog-register.ts` lookup merge; `admin.ts` `hostedBindingHost`). For Gmail this reproduces the snapshot's existing `domains` — no egress change (§7).
- **OAuth stays SDK-owned.** The probe is read-only and carries no credentials; it never touches `mcp-oauth.ts`. No `OAUTH_TOKEN_ENDPOINTS`-style map returns anywhere.

## 6. Catalog path and manual override path

Both registration routes run the **same probe** (§4) before anything persists.

**Catalog connect** (`discoverCatalogMcp` + `lookupCatalogExtension`, `catalog-register.ts`):

1. Generate candidates in §3 order: explicit `entry.mcpEndpoint` (priority 1) → derived `mcp.<domain>/mcp`, `/mcp/v1` (priority 3). (Priority 2 is the manual path, not reachable here.)
2. Probe each candidate in order; first `mcp` or `oauth_challenge` verdict wins; `rejected` → next candidate; exhausted → `lookupCatalogExtension` returns `ok: false` with evidence + the reviewed-override instruction (§8). The RFC 8414 auth-classification probe runs on the validated origin exactly as today (well-known paths at `catalog-register.ts:109-112`), except that an `oauth_challenge` verdict already implies `oauth` without the metadata probe.
3. The validated `serverUrl`/`host` flow into the draft, manifest validation, the approval, and `registerExtensionAtRuntime` unchanged.

**Manual override** (`catalog_browser action=pin`, `admin.ts:863-1013`; also `fetch-catalog.ts --pin` on a hand-edited draft):

1. After the binding merge and shape validation, and **before the `confirm` review gate**, probe the supplied `binding.serverUrl` verbatim (HTTPS-only, `redirect: "error"`).
2. `mcp` or `oauth_challenge` → the pin proceeds to the human confirmation exactly as today.
3. `rejected` → `toolError` with the probe evidence and nothing written — no snapshot, no egress regen, no hot-register; the refusal is auditable (§8, §10).

This is the escape hatch for providers whose catalog record only links documentation — and the load-bearing path for Gmail, whose catalog entry no longer exists (§7).

## 7. Gmail migration (broken snapshot → official `/mcp/v1`)

**Current state.** `config/extensions/gmail-googleapis-com.json` (main tree) pins `mcp.serverUrl: "https://gmailmcp.googleapis.com/mcp"` — a 404 — with `credentialSchema` oauth + `gmail.readonly` scopes, `domains: ["gmail.googleapis.com", "gmailmcp.googleapis.com"]`, `source.reviewed/vendorOfficial: true`. The endpoint is dead; only the endpoint, not the allowlist, is wrong (`config/egress.yml:76-77` already allowlists both domains).

**Replacement.** Re-pin `gmail-googleapis-com` through the **validated override path** with the issue-#274 verified facts: `serverUrl: "https://gmailmcp.googleapis.com/mcp/v1"`, `transport: "streamable-http"`. The draft scaffold already exists at `config/extensions/drafts/gmail-googleapis-com.draft.json` (`vendorOfficial: false`, `reviewed: false`, no binding/credentialSchema yet): complete it with the verified binding + credentialSchema, then `catalog_browser action=pin spec=gmail-googleapis-com binding={...} credential_schema={...} confirm=true` (or `fetch-catalog.ts --pin`) — the pin gate probes the supplied URL verbatim before `confirm` (§6).

**Why the manual path, not the catalog path.** The 2026-08-20T15:47:56Z integrations.sh regen dropped every `discovered/` record; the catalog no longer contains the Gmail entry at all. Catalog connect cannot re-register it — the reviewed override is the only route, which is why it is load-bearing rather than optional.

**Acceptance pair (hermetic, doubles):** `/mcp/v1` passes the generic validation path; `/mcp` fails it.

**Egress:** validated host `gmailmcp.googleapis.com` + scaffold domain `gmail.googleapis.com` reproduce the snapshot's existing `domains` — no egress change, no `OAUTH_TOKEN_ENDPOINTS` entry (the SDK owns OAuth; `mcp-oauth.ts` untouched). The re-pin is idempotent against the already-live registration (resolve → already registered).

## 8. Failure messages

Failures carry the probe evidence and an actionable next step; nothing is registered or pinned.

- **Catalog connect** (`lookupCatalogExtension` → `ok: false`):
  `cannot register "<id>" from the catalog: endpoint <url> failed the MCP validation probe (<evidence>) and no other candidate accepted — nothing was registered. The vendor's hosted MCP endpoint could not be validated. If you have a reviewed official endpoint, register it via catalog_browser action=pin spec=<id> binding={serverUrl: "<reviewed https url>", transport: "streamable-http"} credential_schema={...} confirm=true — the pin path probes the endpoint the same way. Browse the integrations.sh catalog with catalog_browser to find the right id.`
- **Manual pin** (`admin.ts` → `toolError`):
  `refusing to pin "<id>": the binding endpoint <url> failed the MCP validation probe (<evidence>); no snapshot was written and egress is unchanged. Provide the vendor's official endpoint (web-search the vendor's OFFICIAL MCP spec per #146) and pin again — the probe must see a valid MCP initialize response or a standards-compliant Bearer challenge.`
- **HTTPS violation** (either path): `refusing <url>: the MCP endpoint must be https (plain http is never probed).`

`<evidence>` examples: `HTTP 404 (no initialize response, no OAuth Bearer challenge)`, `HTTP 401 without a Bearer WWW-Authenticate challenge`, `HTTP 200 with non-JSON content (HTML landing page)`, `redirect to https://other-host/... (redirects are never followed)`, `request timed out after 10000ms`, `network error: <message>`.

## 9. Caller-level hermetic test matrix

All tests reuse existing seams — injected `fetchImpl`/`stubFetch`, `MemoryRuntimeRegistry`, and the `StubMcpServer` Bun.serve double pattern from `src/extensions/mcp-oauth.test.ts:150-283` (serves initialize JSON-RPC result, 401 + `WWW-Authenticate: Bearer resource_metadata=...`, RFC 9728/8414 metadata). No network.

| # | File | Case | Expected |
|---|---|---|---|
| 1 | `catalog-register.test.ts` | 200 + valid initialize result | `mcp` verdict; serverUrl synthesized; host = validated URL host; domains include it |
| 2 | `catalog-register.test.ts` | 401 + Bearer `resource_metadata` challenge | `oauth_challenge`; `oauthGated: true`; `credentialSchema` oauth |
| 3 | `catalog-register.test.ts` | 404 | rejected; `lookupCatalogExtension` `ok: false` with "reviewed endpoint override" wording; nothing registered |
| 4 | `catalog-register.test.ts` | 401 without `WWW-Authenticate`; `Basic` scheme; 200 + text/html; 202 SSE; timeout; network error | all `rejected` (fail closed) |
| 5 | `catalog-register.test.ts` | `http://` candidate | `rejected` (HTTPS-only) |
| 6 | `catalog-register.test.ts` | explicit `entry.mcpEndpoint` present | honored verbatim, probed, wins over derivation |
| 7 | `catalog-register.test.ts` | derived `/mcp` 404s, `/mcp/v1` accepts | registers `/mcp/v1` (candidate order) |
| 8 | `catalog-register.test.ts` | 301 redirect to another host | `rejected`; egress host never the redirect target |
| 9 | `connect.test.ts` | full lookup→approval→register with 404 double | lookup fails; no runtime row, no egress change, no audit registration |
| 10 | `connect.test.ts` | full flow with `oauth_challenge` double | registers OAuth-gated, tools-less manifest, domains contain validated host |
| 11 | `admin.test.ts` | pin `https://gmailmcp.googleapis.com/mcp/v1` + initialize-success double | pins exactly that URL (file content assert); egress allowlists host |
| 12 | `admin.test.ts` | pin `/mcp` + 404 double | refuses before `confirm`; message contains probe evidence; no snapshot, no egress regen; audit records the refusal |
| 13 | `admin.test.ts` | pin `http://` binding | refuses (HTTPS-only) |
| 14 | egress `generate.test.ts` | OAuth-gated validated binding | allowlist domain present; no credential-injection entry (#284 invariant) |

Existing tests that change: `catalog-register.test.ts:174-230` currently asserts the un-probed convention (`mcp.linear.app/mcp` with a stub that never answers the endpoint); these move to the probe doubles above.

## 10. Rollout and rollback

**Rollout** (one commit, docs-only for this spec; the implementation lands in its own change):

1. Add `probeMcpEndpoint` + verdict types; wire into `discoverCatalogMcp` (§3/§4) and the `admin.ts` pin gate before `confirm` (§6).
2. Update the affected `discoverCatalogMcp` tests and add the §9 matrix.
3. Re-pin Gmail at `/mcp/v1` through the validated override path (§7); verify egress byte-pin tests unchanged (domains reproduce).
4. Optional follow-up (separate issue): `--validate-snapshots` CLI for pinned hosted snapshots; path-aware RFC 9728 metadata probing (SDK `discoverOAuthProtectedResourceMetadata` semantics) beyond the two hardcoded root well-known paths.

**Rollback**: revert the implementation commit. No schema migration — the new `CatalogEntry.mcpEndpoint` field is optional and inert when absent; existing snapshots and runtime-registry rows are untouched (the probe gates only new registrations/pins). A pinned snapshot already written through the validated path (e.g. the Gmail re-pin) remains valid — the probe only ever *added* evidence, never rewrote persisted records.
