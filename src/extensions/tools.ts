/**
 * Extension tool bridge (issue #50): converts registered extensions' typed
 * manifest tools into SDK tool definitions for the space agent's toolset.
 *
 * The bridge is generic by design — bottega never implements provider API
 * clients. Execution belongs to the extension runtime (issue #53,
 * src/extensions/runtime.ts): policy gate → credential ladder → provider
 * call through the egress boundary → audit. The bridge supplies the
 * session context (space id from the session file, caller from the
 * `getCaller` seam) and maps runtime results onto SDK tool results.
 *
 * Manifest tool names are already validated against the runtime's reserved
 * names (manifest.ts), so definitions can never shadow a built-in tool.
 */
import { z, zod, type AgentToolResult, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { toolError } from "../tools/helpers";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import type { ExtensionToolParam } from "./manifest";
import type { ResolvedExtension } from "./registry";
import type { ExtensionRuntime } from "./runtime";
import type { ExtensionSurfaces } from "./surface";

export interface ExtensionToolBridgeOptions {
  /** The runtime every tool executes through (issue #53). */
  runtime: ExtensionRuntime;
  /**
   * Resolves the caller (actor) for a tool call from the session context;
   * defaults to "agent" (the policy extension's actor default). The
   * ladder's personal scope needs the real principal — wired by the
   * adapter layer when it threads the inbound user.
   */
  getCaller?: (ctx: { sessionManager?: { getSessionFile(): string | null | undefined } }) => string | undefined;
  /**
   * Pre-resolved effective tool surfaces (issue #158): extensionId →
   * pinned manifest tools or the discovered tools/list surface. Resolved
   * once at boot by resolveExtensionSurfaces (src/extensions/surface.ts).
   * A tools-less manifest WITHOUT a resolved surface contributes no
   * definitions here (issue #166 — the boot skips providers whose
   * discovery failed); the runtime's lazy per-call path fails closed if a
   * call is attempted anyway.
   */
  surfaces?: ExtensionSurfaces;
}

/**
 * SDK tool definitions for every tool of every registered extension.
 * Fail-closed: an extension without a binding for its kind cannot occur
 * (validateManifest rejects it), any execution failure surfaces as a tool
 * error result (never a silent no-op), and a tools-less manifest without a
 * resolved surface (issue #158) contributes NO definitions (issue #166) —
 * the runtime's lazy per-call path fails closed if a call is attempted
 * anyway, never a silent no-op.
 */
export function extensionToolDefinitions(
  extensions: ResolvedExtension[],
  opts: ExtensionToolBridgeOptions,
): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  for (const resolved of extensions) {
    const { manifest } = resolved;
    // Issue #158: the effective surface is the pinned tools when present
    // (the reviewed path wins — no discovery), else the pre-resolved
    // discovered surface.
    const surface = opts.surfaces?.get(manifest.id) ?? manifest.tools;
    if (surface === undefined) {
      // Issue #166: a tools-less manifest whose provider was unreachable /
      // auth-gated at boot has no resolved surface here. The bridge cannot
      // name its tools, so it contributes no definitions for this extension
      // and the runtime's lazy per-call path fails closed ("tool surface
      // unavailable") if a call is attempted anyway. Never a throw — the
      // boot (which builds these definitions eagerly) must not die on a
      // provider it could not reach.
      continue;
    }
    for (const tool of surface) {
      definitions.push({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: paramsToZodSchema(tool.params),
        approval: tool.tier,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const args = (params ?? {}) as Record<string, unknown>;
          const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
          const caller = opts.getCaller?.(ctx) ?? "agent";
          const result = await opts.runtime.execute({
            extensionId: manifest.id,
            // Issue #148: the runtime call carries the provider's WIRE name
            // (providerName ?? manifest name) — hosted official servers
            // reject bottega's namespaced names (github.search_issues →
            // search_issues). The SDK-facing definition above keeps the
            // manifest name: policy, audit, and the flat model-facing name
            // (#78) are unchanged.
            toolName: tool.providerName ?? tool.name,
            args,
            caller,
            spaceId,
          });
          if (!result.ok) return toolError(result.error);
          return { content: result.content } satisfies AgentToolResult;
        },
      });
    }
  }
  return definitions;
}

/** Declarative manifest params -> zod object schema (required unless marked optional). */
function paramsToZodSchema(params: ExtensionToolParam[]): ReturnType<typeof z.object> {
  const shape: Record<string, zod.ZodLikeSchema<unknown>> = {};
  for (const param of params) {
    const base =
      param.type === "string" ? z.string() : param.type === "number" ? z.number() : z.boolean();
    shape[param.name] = param.required === false ? base.optional() : base;
  }
  return z.object(shape);
}
