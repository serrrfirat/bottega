/**
 * Live-Slack leg of the QA canary (issue #79): a thin fetch-based client
 * over api.slack.com plus the live handle bootstrapping.
 *
 * The harness and canary never import the Slack SDK for the live leg —
 * `@slack/bolt` is a production dependency, and direct fetch keeps the QA
 * tooling dependency-free and obvious. Every method used here is a Slack
 * Web API method called with a JSON body; the canary's own app manifest
 * scopes cover them (see slack-app-manifest.yml and features.md's QA
 * section).
 *
 * Token roles:
 *   - bot token     (SLACK_BOT_TOKEN): Socket Mode adapter auth, channel
 *                   create/invite/list, DM open, permalinks
 *   - app token     (SLACK_APP_TOKEN): the Socket Mode websocket (the
 *                   production adapter owns it)
 *   - QA user token (SLACK_QA_USER_TOKEN): sends inbound messages AS the
 *                   QA user (chat.postMessage as_user) and reads outbound
 *                   history — exactly the "human at the product surface"
 *                   shape the canary exists to exercise
 */
import type { JsonObject } from "../../src/extensions/manifest";

/** Tokens + identity the live leg needs; resolved by the canary from env/Keychain. */
export interface LiveSlackTokens {
  /** App-level token (xapp-...) for the Socket Mode websocket. */
  appToken: string;
  /** Bot user token (xoxb-...) — the adapter's bot identity. */
  botToken: string;
  /** QA user token (xoxp-...) — drives inbound as the human. */
  qaUserToken: string;
  /**
   * The four fixed role/multiplayer identities (issue #298), each a
   * distinct workspace user with its own xoxp token. Optional — the base
   * journeys only need the single QA user; the role/multiplayer journeys
   * fail in CI when any is missing. The user ids resolve from users.list by
   * name when the corresponding id is absent.
   */
  requesterToken?: string;
  approverToken?: string;
  memberToken?: string;
  secondMemberToken?: string;
  /** QA user id; resolved from users.list by name when absent (SLACK_QA_USER_ID). */
  qaUserId?: string;
  /** users.list name filter for the QA user; default "bottega-qa". */
  qaUserName?: string;
  /** Channel the canary creates/locates; default "bottega-qa". */
  channelName?: string;
}

/**
 * The four fixed role/multiplayer identities (issue #298): requester, space
 * approver, ordinary member, second member. Each maps to a distinct
 * workspace user + its own xoxp token for live-role journeys.
 */
export type FixedIdentity = "requester" | "approver" | "member" | "second-member";

/** The token slot + user-id slot for one of the four fixed identities. */
const FIXED_IDENTITY_SLOTS: Record<FixedIdentity, { tokenKey: "requesterToken" | "approverToken" | "memberToken" | "secondMemberToken"; userIdEnv: string; userNameEnv: string }> = {
  requester: { tokenKey: "requesterToken", userIdEnv: "SLACK_QA_REQUESTER_ID", userNameEnv: "SLACK_QA_REQUESTER_NAME" },
  approver: { tokenKey: "approverToken", userIdEnv: "SLACK_QA_APPROVER_ID", userNameEnv: "SLACK_QA_APPROVER_NAME" },
  member: { tokenKey: "memberToken", userIdEnv: "SLACK_QA_MEMBER_ID", userNameEnv: "SLACK_QA_MEMBER_NAME" },
  "second-member": { tokenKey: "secondMemberToken", userIdEnv: "SLACK_QA_SECOND_MEMBER_ID", userNameEnv: "SLACK_QA_SECOND_MEMBER_NAME" },
};

/** A raw message row as Slack's history APIs return it. */
export interface SlackApiMessage {
  ts: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
}

/**
 * A posted message's identity: its own ts plus the thread root it joined
 * (thread_ts present only when Slack posted the message as a reply). The
 * canary's channel journeys poll conversations.replies with the ts of the
 * message the thread hangs under — the post's own ts for a top-level post
 * (the real QA-ping shape, issue #215); a reply-shaped post reports its
 * `thread_ts` so the journey can derive the root instead.
 */
export interface PostedSlackMessage {
  ts: string;
  thread_ts?: string;
}

interface SlackUserRow {
  user_id: string;
  name: string;
  real_name: string;
  is_bot: boolean;
  deleted?: boolean;
}

interface SlackChannelRow {
  id: string;
  name: string;
  is_archived?: boolean;
}

/** Minimal Slack Web API client (JSON bodies, bearer auth). */
export class SlackApiClient {
  constructor(readonly token: string) {}

  async call<T = JsonObject>(
    method: string,
    body: JsonObject = {},
  ): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`slack api ${method}: HTTP ${res.status}`);
    // SAFETY: Slack Web API responses are JSON with a top-level ok/error
    // envelope; T is the caller's declared body shape for the method.
    const data = (await res.json()) as T & { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`slack api ${method}: ${data.error ?? "unknown error"}`);
    return data;
  }
}

/** The subset of the Slack Web API the membership resolution needs (issue #245). */
export interface SlackInviteApi {
  call<T = JsonObject>(method: string, body?: JsonObject): Promise<T>;
}

/**
 * Report whether both roles are really in the channel after best-effort
 * invites (issue #245).
 *
 * conversations.invite rejects a user who is ALREADY in the channel
 * (already_in_channel), so flagging "invited" from invite success
 * misclassifies an already-joined bot as absent: setup-channel then
 * reported "bot in channel: false" for a bot that was really there, and
 * the channel leg ran un-gated. The flag therefore comes from
 * conversations.members — the source of truth — read AFTER the best-effort
 * invites so a freshly invited user counts as joined too; an unreadable
 * members list (no channels:manage scope) fails closed to false.
 *
 * Exported for the hermetic flag test (the decision is pure given an
 * injectable Slack API surface).
 */
export async function resolveChannelMembers(
  api: SlackInviteApi,
  channelId: string,
  users: { bot: string; qa: string },
): Promise<{ bot: boolean; qa: boolean }> {
  // Real membership: the source of truth for the flag (issue #245).
  const readMembers = async (): Promise<string[]> => {
    try {
      const res = await api.call<{ members: string[] }>("conversations.members", { channel: channelId });
      return res.members;
    } catch {
      // no channels:manage (or members read) — reported, never fatal.
      return [];
    }
  };
  let members = await readMembers();
  // Best-effort invites for whoever is missing — already-members are
  // skipped because conversations.invite rejects them (already_in_channel),
  // and a scope shortfall is reported, never fatal.
  for (const userId of [users.bot, users.qa]) {
    if (members.includes(userId)) continue;
    try {
      await api.call("conversations.invite", { channel: channelId, users: userId });
    } catch {
      // already a member or no channels:manage — reported, never fatal.
    }
  }
  // Re-read after the invites: the flag must reflect REAL membership, not
  // whether an invite call happened to succeed (#245). An invite that
  // worked shows up here; an already-member shows up on BOTH reads.
  members = await readMembers();
  return { bot: members.includes(users.bot), qa: members.includes(users.qa) };
}

export interface ChannelEnsureResult {
  id: string;
  created: boolean;
  /** Whether the bot and the QA user were invited (false when the invite failed or was unnecessary). */
  invited: { bot: boolean; qa: boolean };
}

/**
 * The live handle the harness exposes in realSlack mode. The sync members
 * (`channelId`/`user`/`store`) mirror the emulator handle's shape from
 * caches refreshed at boot and by {@link refresh} — the canary uses the
 * async members for fresh reads.
 */
export interface LiveSlackHandle {
  tokens: LiveSlackTokens;
  /** Resolved bot user id (auth.test). */
  botUserId: string;
  /** Resolved QA user id (SLACK_QA_USER_ID or users.list name lookup). */
  qaUserId: string;
  /** DM channel between the bot and the QA user (conversations.open / im.open). */
  dmChannelId: string;
  /** Find-or-create the named private channel; invites bot + QA user. */
  ensureChannel(name: string): Promise<ChannelEnsureResult>;
  /** Re-list users + channels into the sync caches. */
  refresh(): Promise<void>;
  /** Fresh conversation history (each call re-reads the API). */
  history(channelId: string): Promise<SlackApiMessage[]>;
  /**
   * Fresh messages in one thread (conversations.replies): the parent +
   * every reply. conversations.history returns ONLY top-level messages, so
   * a threaded bot reply (channels answer in-thread, #40) is invisible to
   * history — the thread poll is the journey's second eye (issue #212).
   */
  replies(channelId: string, threadTs: string): Promise<SlackApiMessage[]>;
  /** Post a message AS the QA user; resolves with the posted message's identity. */
  postAsUser(channelId: string, text: string): Promise<PostedSlackMessage>;
  /**
   * Post as any of the four fixed identity tokens (issue #298): the
   * requester / approver / member / second-member xoxp tokens from
   * `tokens`. Throws when the named identity has no token wired.
   */
  postAsIdentity(channelId: string, text: string, identity: FixedIdentity): Promise<PostedSlackMessage>;
  /** The resolved user id for one of the four fixed identities; undefined when the token is absent. */
  identityUserId(identity: FixedIdentity): string | undefined;
  /** Permalink for a message (bot token, chat.getPermalink). */
  permalink(channelId: string, ts: string): Promise<string | undefined>;
  // --- SlackHandle-shaped sync surface (cached) ---------------------------
  baseUrl: "";
  store: {
    messages: { all(): Array<{ ts: string; channel_id: string; user: string; text: string; thread_ts?: string }> };
    users: { findOneBy(field: string, value: string): { user_id?: string } | undefined };
    channels: { findOneBy(field: string, value: string): { channel_id?: string } | undefined };
  };
  channelId(name: string): string | undefined;
  user(name: string): string | undefined;
  stop(): void;
}

/** Boots the live handle: identity resolution, DM open, channel cache. */
export async function bootLiveSlack(tokens: LiveSlackTokens): Promise<LiveSlackHandle> {
  const bot = new SlackApiClient(tokens.botToken);
  const qa = new SlackApiClient(tokens.qaUserToken);

  // Bot identity: auth.test works with only the bot token.
  const auth = await bot.call<{ user_id: string }>("auth.test", {});
  const botUserId = auth.user_id;

  // QA user identity: explicit id wins; otherwise users.list name lookup.
  let qaUserId = tokens.qaUserId;
  let usersCache: SlackUserRow[] = [];
  const refreshUsers = async () => {
    const res = await bot.call<{ members: SlackUserRow[] }>("users.list", { limit: 200 });
    usersCache = res.members.filter((m) => m.deleted !== true);
    if (!qaUserId) {
      const name = tokens.qaUserName ?? "bottega-qa";
      qaUserId = usersCache.find((m) => m.name === name || m.real_name === name)?.user_id;
    }
  };
  await refreshUsers();
  if (!qaUserId) {
    throw new Error(
      `live-slack: QA user "${tokens.qaUserName ?? "bottega-qa"}" not found via users.list — ` +
        "create the test user (features.md, issue #79) or pass SLACK_QA_USER_ID",
    );
  }

  // The four fixed identity tokens + their resolved user ids (issue #298).
  // A token's user id resolves from users.list by the identity's name env
  // (default "{role}" seen below) when no explicit id is provided; the
  // live-role journey requires the id to FAIL loudly when the workspace
  // lacks the user.
  const identityClients = new Map<FixedIdentity, SlackApiClient>();
  const identityUserIds = new Map<FixedIdentity, string>();
  for (const identity of Object.keys(FIXED_IDENTITY_SLOTS) as FixedIdentity[]) {
    const slot = FIXED_IDENTITY_SLOTS[identity];
    const token = tokens[slot.tokenKey];
    if (!token) continue;
    identityClients.set(identity, new SlackApiClient(token));
    // An explicit workspace user id from the workflow secret wins (finding #6);
    // otherwise resolve by display name from users.list.
    const explicitId = process.env[slot.userIdEnv]?.trim();
    let found = explicitId ?? undefined;
    if (!found) {
      const name = process.env[slot.userNameEnv]?.trim() ?? identity.replace("-", "-");
      found = usersCache.find((m) => m.name === name || m.real_name === name)?.user_id;
    }
    if (found) identityUserIds.set(identity, found);
    else if (identityClients.has(identity)) {
      // A token was wired but the user could not be resolved — the role
      // journey must fail loudly, never silently skip (issue #298).
      throw new Error(
        `live-slack: identity "${identity}" token is wired but its user id could not be resolved — ` +
          `set ${slot.userIdEnv} (repository secret) or create the ${slot.userNameEnv} user in the workspace (issue #298)`,
      );
    }
  }

  // QA DM: conversations.open with the bot token; fall back to im.open with
  // the QA user token when the bot lacks im:write.
  let dmChannelId: string;
  try {
    const res = await bot.call<{ channel: { id: string } }>("conversations.open", { users: qaUserId });
    dmChannelId = res.channel.id;
  } catch {
    const res = await qa.call<{ channel: { id: string } }>("im.open", { user: qaUserId });
    dmChannelId = res.channel.id;
  }

  let channelsCache: SlackChannelRow[] = [];
  const refreshChannels = async () => {
    const res = await bot.call<{ channels: SlackChannelRow[] }>("conversations.list", {
      types: "public_channel,private_channel",
      limit: 200,
    });
    // Archived rows are skipped so an archived `bottega-qa` is never
    // revived/located — the name falls through to a fresh create.
    channelsCache = res.channels.filter((c) => c.is_archived !== true);
  };
  await refreshChannels();

  // History mirror: updated by every history() read so the sync SlackHandle
  // surface stays roughly fresh; the canary reads history() directly.
  const historyMirror = new Map<string, SlackApiMessage[]>();

  const findUser = (field: string, value: string): SlackUserRow | undefined => {
    // SAFETY: the harness only queries known user row fields (id, name,
    // real_name); an unknown field simply matches nothing.
    const key = field as keyof SlackUserRow;
    return usersCache.find((u) => u[key] === value);
  };
  const findChannel = (field: string, value: string): SlackChannelRow | undefined => {
    // SAFETY: the harness only queries known channel row fields (id, name).
    const key = field as keyof SlackChannelRow;
    return channelsCache.find((c) => c[key] === value);
  };

  const invite = (channelId: string): Promise<{ bot: boolean; qa: boolean }> => {
    // SAFETY: bootLiveSlack already resolved both ids above (auth.test for
    // the bot; the `!qaUserId` throw for QA) — but qaUserId is a `let`
    // reassigned in a nested fn, so the closure cannot narrow it. The guard
    // satisfies the type without a cast and is unreachable in practice.
    const botId = botUserId;
    const qaId = qaUserId;
    if (!qaId) {
      throw new Error("live-slack: invite requires the resolved QA user id (resolved at boot)");
    }
    return resolveChannelMembers(bot, channelId, { bot: botId, qa: qaId });
  };

  return {
    tokens,
    botUserId,
    qaUserId,
    dmChannelId,
    baseUrl: "",
    store: {
      messages: {
        all: () =>
          [...historyMirror.entries()].flatMap(([channelId, msgs]) =>
            msgs.map((m) => ({
              ts: m.ts,
              channel_id: channelId,
              user: m.user ?? m.bot_id ?? "",
              text: m.text,
              ...(m.thread_ts !== undefined ? { thread_ts: m.thread_ts } : undefined),
            })),
          ),
      },
      users: {
        findOneBy: (field, value) => {
          const hit = findUser(field, value);
          return hit ? { user_id: hit.user_id } : undefined;
        },
      },
      channels: {
        findOneBy: (field, value) => {
          const hit = findChannel(field, value);
          return hit ? { channel_id: hit.id } : undefined;
        },
      },
    },
    channelId: (name) => findChannel("name", name)?.id,
    user: (name) => findUser("name", name)?.user_id ?? findUser("real_name", name)?.user_id,
    async refresh() {
      await Promise.all([refreshUsers(), refreshChannels()]);
    },
    async history(channelId) {
      const res = await qa.call<{ messages: SlackApiMessage[] }>("conversations.history", {
        channel: channelId,
        limit: 50,
      });
      historyMirror.set(channelId, res.messages);
      return res.messages;
    },
    async replies(channelId, threadTs) {
      // Issue #215: the call must match the shape the live API verifiably
      // accepts — the manual QA-token call (no limit) returned the thread
      // while the canary's call with limit: 50 was rejected with
      // invalid_arguments (conversations.replies' limit was reduced to 15
      // for some app tiers, 2025-05-29 API change). The default page is
      // plenty for a chat thread; the parameter is the difference between
      // the rejected and the proven call.
      const res = await qa.call<{ messages: SlackApiMessage[] }>("conversations.replies", {
        channel: channelId,
        ts: threadTs,
      });
      return res.messages;
    },
    async postAsUser(channelId, text) {
      const res = await qa.call<{ ts: string; message?: { ts?: string; thread_ts?: string } }>("chat.postMessage", {
        channel: channelId,
        text,
        as_user: true,
      });
      return {
        ts: res.ts,
        ...(res.message?.thread_ts !== undefined ? { thread_ts: res.message.thread_ts } : undefined),
      };
    },
    async postAsIdentity(channelId, text, identity) {
      const client = identityClients.get(identity);
      if (!client) {
        throw new Error(
          `live-slack: identity "${identity}" has no xoxp token wired — the role/multiplayer journey needs it (issue #298)`,
        );
      }
      const res = await client.call<{ ts: string; message?: { ts?: string; thread_ts?: string } }>("chat.postMessage", {
        channel: channelId,
        text,
        as_user: true,
      });
      return {
        ts: res.ts,
        ...(res.message?.thread_ts !== undefined ? { thread_ts: res.message.thread_ts } : undefined),
      };
    },
    identityUserId(identity) {
      return identityUserIds.get(identity);
    },
    async permalink(channelId, ts) {
      try {
        const res = await bot.call<{ permalink?: string }>("chat.getPermalink", {
          channel: channelId,
          message_ts: ts,
        });
        return res.permalink;
      } catch {
        return undefined;
      }
    },
    async ensureChannel(name) {
      const existing = findChannel("name", name);
      if (existing) {
        const invited = await invite(existing.id);
        return { id: existing.id, created: false, invited };
      }
      const created = await bot.call<{ channel: { id: string } }>("conversations.create", {
        name,
        is_private: true,
      });
      await refreshChannels();
      const invited = await invite(created.channel.id);
      return { id: created.channel.id, created: true, invited };
    },
    stop() {
      historyMirror.clear();
    },
  };
}
