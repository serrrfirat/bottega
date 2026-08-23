/**
 * OpenAPI egress provisioner (issue #345): the REAL deployment seam wired
 * into `ExtensionRuntimeDeps.openapiEgress` (replacing the fail-closed
 * default in runtime.ts). It has two halves:
 *
 *   1. `injectForHost(host)` — the fail-closed gate: finds the OPENAPI
 *      extension whose allowlisted domains include `host`, confirms its
 *      static credential is PROVISIONED (the secret file exists in the
 *      proxy secrets dir), and derives the proxy-side inject rule
 *      (header + formatter) from the manifest's auth scheme (bearer →
 *      `Authorization: Bearer {{ .Value }}`; apiKeyHeader → the block's
 *      headerName + `{{ .Value }}`). Undefined when the host is not an
 *      openapi extension or its key is not provisioned — the executor then
 *      refuses to send (fail closed, never an unauthenticated call).
 *
 *   2. `fetchWire(request)` — routes the CREDENTIAL-FREE request through
 *      the proxy env (Bun's native fetch honors HTTP_PROXY/HTTPS_PROXY/
 *      NO_PROXY, proven in src/egress/proxy-env.test.ts). The agent never
 *      holds the key: iron-proxy's generated static inject entry (see
 *      openApiInjectEntries in src/egress/generate.ts) swaps the secret in
 *      for the allowlisted host at egress. The seam never sees the secret
 *      and never attaches it to the request.
 *
 * Still fail-closed when unconfigured: a host with no openapi extension, a
 * non-openapi host, or a host whose key file is absent → `injectForHost`
 * returns undefined and `callOpenApiTool` refuses to send.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  extensionSecretFileName,
  PROXY_SECRETS_DIR,
} from "./boundary";
import type {
  OpenApiEgressInject,
  OpenApiEgressSeam,
  OpenApiWireRequest,
} from "./openapi-executor";
import type { ExtensionRegistry } from "./registry";

/** Derives the proxy-side inject rule from an openapi manifest's auth scheme (issue #345). */
function injectForAuthScheme(
  extensionId: string,
  scheme: "bearer" | "apiKeyHeader",
  headerName: string | undefined,
): OpenApiEgressInject {
  if (scheme === "bearer") {
    return { header: "Authorization", formatter: "Bearer {{ .Value }}" };
  }
  if (headerName === undefined || headerName.trim() === "") {
    throw new Error(
      `openapi egress: extension "${extensionId}" declares apiKeyHeader auth without a "headerName" — cannot inject`,
    );
  }
  return { header: headerName, formatter: "{{ .Value }}" };
}

/** A resolved openapi inject entry, keyed by its allowlisted host. */
interface OpenApiHostEntry {
  extensionId: string;
  header: string;
  formatter: string;
}

export interface OpenApiEgressSeamOpts {
  /** The live extension registry (find the openapi manifest for a host). */
  registry: Pick<ExtensionRegistry, "list">;
  /** Host-side secrets dir; defaults to BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR. */
  secretsDir?: string;
  /** Test seam; defaults to the global fetch (Bun-native proxy-env wiring). */
  fetchImpl?: typeof fetch;
}

/**
 * Builds the production OpenAPI egress seam (issue #345). See the module
 * doc for the two halves. Deployments wire this into
 * `ExtensionRuntimeDeps.openapiEgress`; the default stays the fail-closed
 * seam until then.
 */
export function createOpenApiEgressSeam(opts: OpenApiEgressSeamOpts): OpenApiEgressSeam {
  const secretsDir = opts.secretsDir ?? process.env.BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR;
  const fetchImpl = opts.fetchImpl ?? fetch;
  // The openapi surface is FROZEN at pin, but a runtime-registered openapi
  // extension joins the live registry WHILE the server runs (the catalog
  // connect path, issue #345), so injectForHost resolves the host against
  // the LIVE registry per call rather than a construction-time snapshot.
  const entryForHost = (host: string): OpenApiHostEntry | undefined => {
    for (const entry of opts.registry.list()) {
      const manifest = entry.manifest;
      if (manifest.kind !== "openapi") continue;
      if (!manifest.domains.includes(host)) continue;
      return {
        extensionId: manifest.id,
        ...injectForAuthScheme(manifest.id, manifest.openapi.auth.scheme, manifest.openapi.auth.headerName),
      };
    }
    return undefined;
  };
  return {
    injectForHost(host: string): OpenApiEgressInject | undefined {
      const entry = entryForHost(host);
      if (entry === undefined) return undefined;
      // Fail closed when the static credential is NOT provisioned: the
      // proxy's inject entry requires the secret file to exist, so an
      // absent file means the connect never provisioned the key — refuse
      // to send rather than let an unauthenticated request reach the vendor.
      if (!existsSync(join(secretsDir, extensionSecretFileName(entry.extensionId)))) {
        return undefined;
      }
      return { header: entry.header, formatter: entry.formatter };
    },
    async fetchWire(request: OpenApiWireRequest): Promise<{ status: number; body: string }> {
      // The credential-free request rides the proxy env (Bun-native
      // HTTP_PROXY/HTTPS_PROXY/NO_PROXY passthrough, provenance in
      // src/egress/proxy-env.test.ts): iron-proxy injects the static key
      // at egress and enforces the allowlist. The seam attaches NO header.
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : undefined),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}