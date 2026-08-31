# Self-Hosted SearXNG Search Design

**Issue:** #388
**Status:** Approved in conversation
**Date:** 2026-08-29

## Goal

Replace the account-required Tavily backend behind Bottega's existing
`search_web` tool with a self-hosted SearXNG service. Keep the current policy,
citation, Slack, and tool-call contracts. Deploy the change to the production
DigitalOcean droplet without a search-vendor account or API key.

The agent must know when search is appropriate. The `search_web` tool
description will explicitly tell it to search when information is current,
external, research-oriented, news-related, comparative, or needs cited URLs.
It will also tell the agent not to search for repository-local facts.

## Non-goals

- Do not add a second agent-facing search tool.
- Do not add `mcp-searxng` or another MCP process.
- Do not expose SearXNG to the public internet.
- Do not add browser solvers, CAPTCHA bypasses, or anti-detection code.
- Do not promise that upstream public search engines have an availability SLA.
- Do not change Slack citation-table behavior.
- Do not keep a dormant Tavily compatibility path.

## Decision

Use SearXNG's internal JSON HTTP API directly from the existing `search_web`
tool.

```text
Space agent
    |
    | search_web(query, max_results)
    v
Bottega search tool and policy gate
    |
    | HTTP GET /search?q=...&format=json
    v
Internal SearXNG container
    |
    | HTTP(S)_PROXY
    v
iron-proxy default-deny egress
    |
    v
Reviewed keyless search engines
```

This is smaller than an MCP integration. Bottega already owns the important
agent-facing behavior: policy gating, readable tool metadata, structured
results, citations, Slack tables, auditing, and fail-closed delivery. An MCP
server would duplicate that surface and would need a second citation bridge.

## SearXNG service

Add one internal Compose service named `searxng`.

- Image: `searxng/searxng:2026.8.29-d226b78bc` pinned to OCI index digest
  `sha256:b36af7984b87191b595bc5301418ed6432c047668a4547ab531a7439b816fac3`.
- No host port is published.
- The service joins only the `egress` network.
- DNS points at iron-proxy (`172.30.0.2`).
- `HTTP_PROXY` and `HTTPS_PROXY` point at `http://iron-proxy:8080`.
- The iron-proxy CA is mounted read-only and configured through
  `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE` as supported by the image.
- `NO_PROXY` contains only loopback and internal service names.
- The container is read-only, drops all capabilities, uses
  `no-new-privileges`, has a bounded tmpfs, PID limit, memory limit, and
  restart policy consistent with production services.
- A local health check verifies the SearXNG HTTP process without performing an
  external search.
- The Bottega server waits for the service health check.

The service reads a committed `config/searxng/settings.yml` file. The
configuration enables JSON output and keeps only two reviewed general-web
engines:

- DuckDuckGo (`html.duckduckgo.com`)
- Brave (`search.brave.com`)

SearXNG's secret key remains a deployment secret. It is supplied by
`SEARXNG_SECRET` in the deployment `.env`; `.env.example` documents it without
a value. No search-provider credential is stored.

Public SearXNG instances are not used. They are outside Bottega's trust and
availability boundary.

## Egress policy

SearXNG has no direct route around iron-proxy. Add exactly
`html.duckduckgo.com` and `search.brave.com` to `BASE_EGRESS_DOMAINS`,
`JUDGED_HOSTS`, and the generated strict/dev policies. No wildcard search
engine domains are permitted.

These are content-bearing search requests, so they remain in `JUDGED_HOSTS`.
The judge fallback stays `deny`. Unknown SearXNG engines and unknown outbound
hosts fail closed at iron-proxy.

Remove Tavily from:

- `MODEL_GATEWAY_KEYS`
- base egress domains and judge hosts
- static proxy-secret generation
- boot-secret declarations
- `.env.example`
- upload-link/connect provider lists
- tests and documentation
- committed generated egress policies

No `tavily.secret`, `TAVILY_API_KEY`, or `api.tavily.com` path remains.

## `search_web` tool contract

Keep the public tool name and arguments:

```ts
search_web({ query: string, max_results?: number })
```

The implementation changes as follows:

1. Trim and validate the query.
2. Build a GET request to the internal SearXNG `/search` endpoint with:
   - `q=<query>`
   - `format=json`
   - `safesearch=1`
   - a general search category
3. Parse the SearXNG JSON response through a typed Zod boundary.
4. Read `title`, `url`, and `content` from each valid result.
5. Drop malformed rows without URLs.
6. Cap results to `max_results` (default 5, maximum 10).
7. Return the existing `{ query, count, results }` JSON shape with
   `{ title, url, snippet }` rows.

The citation presenter and `onSearchResults` path remain unchanged.

The new single-line model-visible description will say, in substance:

> Search the public web for current, external, research, news, comparison, or
> source-verifiable information; use cited URLs, and do not use this tool for
> repository-local facts.

This is the agent's tool-selection instruction. The tool stays read-tier and
requires no human approval.

## Failure behavior

Fail closed and return a visible tool error when:

- SearXNG is unavailable or times out.
- SearXNG returns a non-2xx response.
- The response is not valid JSON.
- The response does not match the typed result boundary.

An empty but valid SearXNG result list is a successful search with zero
results. It is not fabricated into an answer.

No raw HTML, stack trace, proxy response, or internal container address enters
Slack. Error text is bounded before it reaches the tool result.

## Testing

### Unit

Update `src/tools/search-web.test.ts` to prove:

- the tool description names the required use cases and repository-local
  exclusion
- the request uses SearXNG GET parameters
- SearXNG results map to the existing cited result shape
- result caps hold
- empty valid results stay empty
- malformed bodies and non-2xx responses fail closed
- unavailable service errors are visible and bounded
- no key or secret file is required

### Hermetic integration

- Keep provider HTTP tests on local `Bun.serve` doubles.
- Drive the real policy-gated `search_web` call and citation sink.
- Validate Compose service security, internal-only networking, health check,
  proxy variables, and server dependency.
- Validate the strict and dev egress generators and committed files.
- Search the repository for removed Tavily names after the cutover.

### Production smoke

After deployment:

1. Confirm `searxng`, `iron-proxy`, `auth-broker`, and `server` are healthy.
2. Query the internal SearXNG JSON endpoint from the server network.
3. Send or simulate a current-information `search_web` request.
4. Confirm at least one result has a title, URL, and snippet.
5. Confirm the Slack citation path still accepts the structured result.
6. Confirm iron-proxy logs show only reviewed engine hosts.

A live Slack-user leg is reported only if a QA user token or browser session is
available.

## Deployment

1. Generate and review strict/dev egress files.
2. Run typecheck, focused search/egress/Compose tests, affected E2E tests, and
   the project quality gate.
3. Push the feature branch directly to `main` under the repository workflow.
4. Pull `main` on `/opt/bottega`.
5. Recreate egress policy initialization, iron-proxy, SearXNG, and server so
   the new policy and service are active.
6. Run the production smoke checks above.
7. Comment on and close issue #388 only after production evidence exists.

## Rollback

Rollback uses the previous known-good Bottega commit and Compose configuration.
Recreate iron-proxy and server from that revision. The old revision requires a
Tavily key, so rollback is viable only while the prior Tavily credential is
still available. The SearXNG container has no durable user data and can be
removed as an orphan after rollback.

## Acceptance criteria

- `search_web` works without Exa, Tavily, or another search-vendor account.
- The existing tool name, policy tier, result JSON, citation sink, and Slack
  citation table remain compatible.
- The agent-facing tool description states when to search and when not to.
- SearXNG is internal-only and all of its outbound traffic crosses
  iron-proxy.
- Only reviewed search-engine hosts are reachable.
- Tavily credentials and code paths are removed completely.
- Missing or malformed search service responses fail closed.
- Production health and a real structured search are verified on the droplet.
