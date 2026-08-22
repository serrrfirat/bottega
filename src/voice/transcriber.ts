/**
 * Slack voice-note transcription (issue #96).
 *
 * Speech-to-text against the NEAR AI Cloud OpenAI-compatible
 * audio/transcriptions endpoint (multipart `{file, model}`), which the
 * SpaceService voice-note leg uses to turn a Slack voice clip into turn
 * text and org memory. The NEAR key is read from `process.env.NEAR_API_KEY`
 * (seeded post-boot like every other model key — see proxy-seed.ts), so the
 * factory takes the key explicitly and the caller decides where it comes
 * from. baseUrl/model default to the NEAR values and may be overridden by
 * org settings `voice.transcription`.
 */
import { z } from "zod";

/** NEAR AI Cloud OpenAI-compatible API base (the retired api.near.ai never comes back). */
export const NEAR_TRANSCRIBE_BASE_URL = "https://cloud-api.near.ai/v1";
/** NEAR AI Cloud transcription model. */
export const NEAR_TRANSCRIBE_MODEL = "openai/whisper-large-v3";
/** Hard cap on a transcribable voice clip (25 MiB), en route to STT. */
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Mime types the voice-note leg accepts. Slack transcribes voice clips to
 * mp4/ogg/mpeg/wav; anything else (a video, an arbitrary `audio/*` upload)
 * is rejected explicitly rather than guessed at.
 */
export const VOICE_ACCEPTED_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
]);

/** The transcript-capable object the SpaceService voice-note leg uses. */
export interface NearTranscriber {
  /**
   * False when no API key was supplied — the caller must surface an
   * explicit "voice notes are not configured" error instead of calling
   * {@link transcribe}.
   */
  readonly configured: boolean;
  /**
   * Transcribes `bytes` to text via the NEAR endpoint's multipart
   * transcription. Non-2xx responses throw an Error naming the HTTP status;
   * a successful response must carry JSON `{ text: string }`. Throws on
   * network failure or an unparseable/absent `text`.
   */
  transcribe(bytes: Uint8Array, filename: string, mimeType: string): Promise<string>;
}

/** Factory options; all override the NEAR defaults. */
export interface NearTranscriberOptions {
  /** NEAR AI Cloud API key; empty → {@link NearTranscriber.configured} is false. */
  apiKey?: string;
  /** API base; defaults to {@link NEAR_TRANSCRIBE_BASE_URL}. */
  baseUrl?: string;
  /** Transcription model; defaults to {@link NEAR_TRANSCRIBE_MODEL}. */
  model?: string;
}

const transcriptionResponseSchema = z.object({
  text: z.string(),
});

/**
 * Builds a {@link NearTranscriber}. Pass `apiKey: ""`/undefined for the
 * "voice notes not configured" state — the returned object is safe to
 * construct and inspect but {@link NearTranscriber.transcribe} throws a
 * configured-guard error.
 */
export function createNearTranscriber(opts: NearTranscriberOptions = {}): NearTranscriber {
  const apiKey = opts.apiKey?.trim() ?? "";
  const configured = apiKey !== "";
  const baseUrl = (opts.baseUrl ?? NEAR_TRANSCRIBE_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? NEAR_TRANSCRIBE_MODEL;
  return {
    configured,
    async transcribe(bytes, filename, mimeType) {
      if (!configured) {
        throw new Error("voice notes are not configured: NEAR_API_KEY is not set");
      }
      const body = new FormData();
      // The model field rides alongside the file part; the server parses
      // the multipart body and returns the transcript JSON.
      body.append("model", model);
      body.append("file", new Blob([bytes], { type: mimeType }), filename);
      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body,
      });
      if (!res.ok) {
        throw new Error(`voice transcription failed with HTTP ${res.status}`);
      }
      const parsed = transcriptionResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new Error("voice transcription returned an unparseable response");
      }
      return parsed.data.text;
    },
  };
}