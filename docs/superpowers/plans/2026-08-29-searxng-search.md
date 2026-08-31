# Self-Hosted SearXNG Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Tavily with an internal, no-account SearXNG backend while preserving Bottega's `search_web` policy, citation, and Slack contracts.

**Architecture:** `search_web` calls SearXNG's internal JSON API directly. SearXNG runs as a pinned, internal-only Compose service whose outbound DuckDuckGo and Brave requests cross iron-proxy. Tavily credentials and gateway paths are removed in one clean cutover.

**Tech Stack:** Bun/TypeScript, `bun:test`, Docker Compose, SearXNG 2026.8.29, iron-proxy 0.49.0, Zod.

**Approved design:** `docs/superpowers/specs/2026-08-29-searxng-search-design.md`

---

## File map

- Modify `src/tools/search-web.ts`: SearXNG GET client, typed result mapping, agent tool-selection description.
- Modify `src/tools/search-web.test.ts`: SearXNG request/response/error/description contracts.
- Create `config/searxng/settings.yml`: JSON API plus DuckDuckGo/Brave-only engine policy.
- Modify `docker-compose.yml`: internal SearXNG service and server dependency.
- Modify `src/deploy.test.ts`, `src/secrets/compose.test.ts`, and related Compose tests: service security and topology.
- Modify `src/egress/generate.ts`, `src/egress/generate.test.ts`, `src/egress/egress-config.test.ts`: search-engine allowlist/judge cutover.
- Regenerate `config/egress.yml` and `config/egress.dev.yml`.
- Modify `src/extensions/proxy-seed.ts` and tests: remove Tavily static credential.
- Modify `src/server/boot-secrets.ts` and tests: remove Tavily vault boot secret.
- Modify `.env.example`, workflow files, `scripts/smoke.sh`, `architecture.md`, and affected tests: remove Tavily and document SearXNG.

---

### Task 1: Cut `search_web` over to SearXNG

**Files:**

- Modify: `src/tools/search-web.ts`
- Modify: `src/tools/search-web.test.ts`

- [ ] **Step 1: Write failing SearXNG behavior tests**

Add tests that construct the real tool with a local `Bun.serve` provider and assert:

```ts
expect(tool.description).toContain("current");
expect(tool.description).toContain("external");
expect(tool.description).toContain("research");
expect(tool.description).toContain("news");
expect(tool.description).toContain("comparison");
expect(tool.description).toContain("repository-local");
```

The provider handler must capture a GET request and return:

```json
{
  "results": [
    {
      "title": "SearXNG documentation",
      "url": "https://docs.searxng.org/",
      "content": "A self-hosted metasearch engine"
    }
  ]
}
```

Assert the request URL carries:

```ts
expect(url.pathname).toBe("/search");
expect(url.searchParams.get("q")).toBe("bottega search");
expect(url.searchParams.get("format")).toBe("json");
expect(url.searchParams.get("categories")).toBe("general");
expect(url.searchParams.get("safesearch")).toBe("1");
```

Assert the existing tool result remains:

```ts
expect(JSON.parse(resultText(result))).toEqual({
  query: "bottega search",
  count: 1,
  results: [
    {
      title: "SearXNG documentation",
      url: "https://docs.searxng.org/",
      snippet: "A self-hosted metasearch engine",
    },
  ],
});
```

Also add independent tests for valid empty results, non-2xx, malformed JSON,
malformed result envelopes, result caps, and an unreachable local service.
Remove all key-file fixtures and assertions.

- [ ] **Step 2: Run the search tests and verify RED**

```bash
bun test src/tools/search-web.test.ts
```

Expected: failures show the old Tavily POST/body/key behavior.

- [ ] **Step 3: Implement the minimal SearXNG client**

Use this provider boundary in `src/tools/search-web.ts`:

```ts
const DEFAULT_SEARCH_BASE_URL = "http://searxng:8080";
const SEARCH_PATH = "/search";

const providerResultSchema = z.object({
  title: z.string().optional().default(""),
  url: z.string().optional().default(""),
  content: z.string().optional().default(""),
});

const providerSearchResponseSchema = z.object({
  results: z.array(providerResultSchema),
});
```

Keep only `baseUrl` and `fetch` in `SearchWebToolOpts`. Delete
`SEARCH_PROVIDER`, `PROXY_PLACEHOLDER`, `searchSecretsDir`,
`searchKeySeeded`, filesystem imports, and the early key check.

Build the request without credentials:

```ts
const url = new URL(SEARCH_PATH, `${baseUrl}/`);
url.searchParams.set("q", query);
url.searchParams.set("format", "json");
url.searchParams.set("categories", "general");
url.searchParams.set("safesearch", "1");
const response = await doFetch(url, { method: "GET" });
```

Map only valid URL rows and preserve the existing result shape:

```ts
const results = parsed.data.results
  .filter((row) => row.url.trim() !== "")
  .slice(0, max)
  .map((row) => ({
    title: row.title,
    url: row.url,
    snippet: row.content,
  }));
```

Use this one-line model-visible description:

```ts
"Search the public web for current, external, research, news, comparison, or source-verifiable information; use the cited URLs in the answer, and do not use this tool for repository-local facts."
```

Keep read-tier approval and bounded provider-error text.

- [ ] **Step 4: Run the search tests and verify GREEN**

```bash
bun test src/tools/search-web.test.ts
```

Expected: all search tests pass without a secret file.

- [ ] **Step 5: Commit the provider cutover**

```bash
git add src/tools/search-web.ts src/tools/search-web.test.ts
git commit -m "feat(search): used SearXNG backend (#388)"
```

---

### Task 2: Add the internal SearXNG service

**Files:**

- Create: `config/searxng/settings.yml`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `src/deploy.test.ts`
- Modify: `src/secrets/compose.test.ts`

- [ ] **Step 1: Write failing Compose contract tests**

Add assertions that the parsed `searxng` service:

- uses `searxng/searxng:2026.8.29-d226b78bc@sha256:b36af7984b87191b595bc5301418ed6432c047668a4547ab531a7439b816fac3`
- publishes no host ports
- joins only `egress` at `172.30.0.6`
- uses DNS `172.30.0.2`
- routes `HTTP_PROXY`/`HTTPS_PROXY` to `http://iron-proxy:8080`
- mounts `config/searxng/settings.yml` and the iron-proxy CA read-only
- is read-only, capability-free, PID/memory bounded, and `no-new-privileges`
- has a local HTTP health check
- receives `SEARXNG_SECRET` through required Compose interpolation

Assert `server.depends_on.searxng.condition === "service_healthy"` and server
`NO_PROXY` contains `searxng`.

- [ ] **Step 2: Run Compose tests and verify RED**

```bash
bun test src/deploy.test.ts src/secrets/compose.test.ts
```

Expected: `searxng` service is missing.

- [ ] **Step 3: Add the reviewed SearXNG settings**

Create `config/searxng/settings.yml`:

```yaml
use_default_settings:
  engines:
    keep_only:
      - duckduckgo
      - brave

general:
  debug: false
  instance_name: bottega-search

search:
  safe_search: 1
  formats:
    - html
    - json

server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "ultrasecretkey"
  limiter: false
  image_proxy: false
```

The official container replaces `ultrasecretkey` from `SEARXNG_SECRET`.

- [ ] **Step 4: Add the hardened Compose service**

Add `searxng` with the pinned image/digest, `depends_on: iron-proxy`, fixed DNS,
proxy variables, CA variables, required `SEARXNG_SECRET`, read-only mounts,
`/tmp` and `/var/cache/searxng` tmpfs, health check, security limits, and fixed
egress IP. Add the server dependency and `searxng` to server `NO_PROXY`.

Add to `.env.example`:

```dotenv
# Internal SearXNG session/signing secret; generate with: openssl rand -hex 32
SEARXNG_SECRET=
```

- [ ] **Step 5: Run Compose tests and config validation**

```bash
bun test src/deploy.test.ts src/secrets/compose.test.ts
docker compose -f docker-compose.yml config -q
```

Expected: tests and Compose validation pass when `SEARXNG_SECRET` is supplied a
non-empty test value by the test harness.

- [ ] **Step 6: Commit the service**

```bash
git add config/searxng/settings.yml docker-compose.yml .env.example src/deploy.test.ts src/secrets/compose.test.ts
git commit -m "feat(search): added internal SearXNG service (#388)"
```

---

### Task 3: Remove Tavily and constrain search egress

**Files:**

- Modify: `src/egress/generate.ts`
- Modify: `src/egress/generate.test.ts`
- Modify: `src/egress/egress-config.test.ts`
- Modify: `config/egress.yml`
- Modify: `config/egress.dev.yml`
- Modify: `src/extensions/proxy-seed.ts`
- Modify: `src/extensions/proxy-seed.test.ts`
- Modify: `src/server/boot-secrets.ts`
- Modify: `src/server/boot-secrets.test.ts`
- Modify: `src/extensions/upload-link.test.ts`
- Modify: `src/worker/run-job.ts`
- Modify: `src/worker/run-job.test.ts`
- Modify: `.github/workflows/canary.yml`
- Modify: `.github/workflows/nightly-canary.yml`

- [ ] **Step 1: Write failing egress and credential tests**

Change tests to require:

```ts
expect(BASE_EGRESS_DOMAINS).toContain("html.duckduckgo.com");
expect(BASE_EGRESS_DOMAINS).toContain("search.brave.com");
expect(JUDGED_HOSTS).toContain("html.duckduckgo.com");
expect(JUDGED_HOSTS).toContain("search.brave.com");
expect(rendered).not.toContain("tavily");
expect(rendered).not.toContain("api.tavily.com");
```

Update secret counts and provider sets so Tavily is absent. Remove Tavily from
boot-secret, upload-link, sandbox-env, and workflow expectations.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
bun test \
  src/egress/generate.test.ts \
  src/egress/egress-config.test.ts \
  src/extensions/proxy-seed.test.ts \
  src/server/boot-secrets.test.ts \
  src/extensions/upload-link.test.ts \
  src/worker/run-job.test.ts
```

Expected: old Tavily gateway/credential assertions fail.

- [ ] **Step 3: Apply the clean cutover**

In `src/egress/generate.ts`:

```ts
export const JUDGED_HOSTS = [
  "html.duckduckgo.com",
  "search.brave.com",
  "raw.githubusercontent.com",
] as const;
```

Remove the Tavily gateway entry and replace `gatewayHost("tavily")` in
`BASE_EGRESS_DOMAINS` with the two exact search hosts.

Remove Tavily from `MODEL_PROXY_KEYS`, `BOOT_SECRETS`, upload-link IDs,
sandbox environment denylist, workflow env, and all related tests/comments.
Do not leave a compatibility alias or unused env setting.

- [ ] **Step 4: Regenerate committed egress policies**

```bash
bun run src/egress/generate.ts
```

Verify the strict policy contains the two search hosts in allowlist and judge,
and contains no Tavily secret rule. Verify the dev policy contains no Tavily
secret rule.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command, then:

```bash
bun test src/tools/search-web.test.ts
```

Use the repository search tool for `TAVILY|tavily|api\\.tavily\\.com`, excluding
the approved design and implementation plan files.

Expected: focused tests pass; repository search has no product/config/test
matches. Historical design/plan references are allowed.

- [ ] **Step 6: Commit the security cutover**

```bash
git add \
  src/egress/generate.ts src/egress/generate.test.ts src/egress/egress-config.test.ts \
  config/egress.yml config/egress.dev.yml \
  src/extensions/proxy-seed.ts src/extensions/proxy-seed.test.ts \
  src/server/boot-secrets.ts src/server/boot-secrets.test.ts \
  src/extensions/upload-link.test.ts src/worker/run-job.ts src/worker/run-job.test.ts \
  .github/workflows/canary.yml .github/workflows/nightly-canary.yml
git commit -m "refactor(search): removed Tavily credential path (#388)"
```

---

### Task 4: Update operator documentation and ship

**Files:**

- Modify: `README.md`
- Modify: `architecture.md`
- Modify: `scripts/smoke.sh`
- Verify: all Task 1-3 files

- [ ] **Step 1: Update existing documentation**

Document that `search_web` uses internal SearXNG with DuckDuckGo and Brave,
requires no search account/key, and remains best-effort because upstream public
engines may throttle the droplet IP. Update `scripts/smoke.sh` to check SearXNG
health and a structured cited search instead of a Tavily secret file.

- [ ] **Step 2: Run the final local quality gate**

```bash
bun check
bun test \
  src/tools/search-web.test.ts \
  src/egress/generate.test.ts \
  src/egress/egress-config.test.ts \
  src/extensions/proxy-seed.test.ts \
  src/server/boot-secrets.test.ts \
  src/deploy.test.ts \
  src/secrets/compose.test.ts \
  src/server/drivers/agent-driver.test.ts
docker compose -f docker-compose.yml config -q
NODE_ENV=test bun test --parallel=1 tests/e2e src/models/proxy-placeholder.test.ts
```

Expected: all commands exit 0. If the unrelated full unit gate still retains
native handles, record issue #387 rather than changing search scope.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md architecture.md scripts/smoke.sh
git commit -m "docs(search): documented self-hosted web search (#388)"
```

- [ ] **Step 4: Rebase and push directly to main**

```bash
git pull --rebase origin main
git push origin HEAD:main
```

Never force-push.

- [ ] **Step 5: Deploy the full policy and service cutover**

On the droplet:

```bash
sudo git -C /opt/bottega pull --ff-only origin main
sudo docker compose \
  --project-directory /opt/bottega \
  -f /opt/bottega/docker-compose.yml \
  -f /opt/bottega/docker-compose.prod.yml \
  up -d --build
```

Generate `SEARXNG_SECRET` into `/opt/bottega/.env` before Compose interpolation
if it is absent. Do not print the value.

- [ ] **Step 6: Verify production behavior**

Verify:

```bash
sudo docker compose --project-directory /opt/bottega \
  -f /opt/bottega/docker-compose.yml \
  -f /opt/bottega/docker-compose.prod.yml ps
```

Then run an internal JSON search from the server network and assert at least one
result has non-empty `title`, `url`, and `content`. Check server logs for Slack
Socket Mode connection and iron-proxy logs for only
`html.duckduckgo.com`/`search.brave.com` search egress.

- [ ] **Step 7: Close issue #388**

```bash
gh issue close 388 \
  --repo serrrfirat/bottega \
  --comment "Shipped and deployed self-hosted SearXNG search with production health, structured-result, and egress evidence."
```
