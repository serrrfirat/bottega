/**
 * Live-Slack leg of the QA canary (issue #79): a thin fetch-based client
 * over api.slack.com plus the live handle bootstrapping.
 *
 * The harness and canary never import the Slack SDK for the live leg —
 * `@slack/bolt` is a production dependency, and direct fetch keeps the QA
 * tooling dependency-free and obvious. Every method used here is a Slack
 * Web API method called with a JSON body; the canary's own app manifest
 * scopes cover them (see slack-app-manifest.yml and the README's QA
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

/** Tokens + identity the live leg needs; resolved by the canary from env/Keychain. */
export interface LiveSlackTokens {
  /** App-level token (xapp-...) for the Socket Mode websocket. */
  appToken: string;
  /** Bot user token (xoxb-...) — the adapter's bot identity. */
  botToken: string;
  /** QA user token (xoxp-...) — drives inbound as the human. */
  qaUserToken: string;
  /** QA user id; resolved from users.list by name when absent (SLACK_QA_USER_ID). */
  qaUserId?: string;
  /** users.list name filter for the QA user; default "bottega-qa". */
  qaUserName?: string;
  /** Channel the canary creates/locates; default "bottega-qa". */
  channelName?: string;
}

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

  async call<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown> = {},
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
    const data = (await res.json()) as T & { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`slack api ${method}: ${data.error ?? "unknown error"}`);
    return data;
  }
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
  /** Post a message AS the QA user; resolves with the message ts. */
  postAsUser(channelId: string, text: string): Promise<string>;
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
        "create the test user (README, issue #79) or pass SLACK_QA_USER_ID",
    );
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
    const key = field as keyof SlackUserRow;
    return usersCache.find((u) => u[key] === value);
  };
  const findChannel = (field: string, value: string): SlackChannelRow | undefined => {
    const key = field as keyof SlackChannelRow;
    return channelsCache.find((c) => c[key] === value);
  };

  const invite = async (channelId: string): Promise<{ bot: boolean; qa: boolean }> => {
    const invited = { bot: false, qa: false };
    for (const [label, user] of [
      ["bot", botUserId],
      ["qa", qaUserId],
    ] as const) {
      try {
        await bot.call("conversations.invite", { channel: channelId, users: user });
        invited[label] = true;
      } catch {
        // already a member or no channels:manage — reported, never fatal.
      }
    }
    return invited;
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
              ...(m.thread_ts !== undefined ? { thread_ts: m.thread_ts } : {}),
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
    async postAsUser(channelId, text) {
      const res = await qa.call<{ ts: string }>("chat.postMessage", {
        channel: channelId,
        text,
        as_user: true,
      });
      return res.ts;
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
