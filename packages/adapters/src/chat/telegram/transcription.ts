/**
 * Audio transcription via Groq whisper-large-v3-turbo.
 *
 * Used by the Telegram adapter to turn voice notes / audio uploads into
 * text before feeding them into the orchestrator. Kept framework-agnostic:
 * callers pass raw bytes + filename, we return the transcript.
 *
 * Why Groq: free tier (7200 audio-sec/day, 30 RPM) comfortably covers
 * single-developer use, 2-3× realtime vs OpenAI, identical API shape so
 * a future swap to the official Anthropic audio content block (once
 * shipped) or OpenAI Whisper is trivial.
 *
 * Failure surface is intentionally explicit (TranscriptionError with a
 * small enum of codes) so the adapter can tell the user what went wrong
 * instead of swallowing the problem.
 */
import { createLogger } from '@archon/paths';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_TIMEOUT_MS = 60_000;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram.transcription');
  return cachedLog;
}

export type TranscriptionErrorCode =
  | 'missing_key'
  | 'api_error'
  | 'rate_limit'
  | 'timeout'
  | 'network_error'
  | 'invalid_response';

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  readonly httpStatus?: number;

  constructor(message: string, code: TranscriptionErrorCode, httpStatus?: number) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface TranscriptionResult {
  /** Full transcript as returned by the model. */
  text: string;
  /** Detected language code (e.g. "en", "uk") when available. */
  language?: string;
}

export interface TranscribeOptions {
  /** API key override — defaults to process.env.GROQ_API_KEY. */
  apiKey?: string;
  /** ISO 639-1 language hint. Omit for auto-detect. */
  language?: string;
  /** Request timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Custom endpoint (for testing / mocking). */
  endpoint?: string;
  /** fetch implementation override (for testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Transcribe raw audio bytes via Groq Whisper.
 *
 * Throws {@link TranscriptionError} — callers should catch and decide whether
 * to notify the user (missing_key, rate_limit) or just log (transient).
 */
export async function transcribeAudio(
  audioBytes: Uint8Array,
  filename: string,
  options: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new TranscriptionError(
      'GROQ_API_KEY is not configured — add it to ~/.archon/.env to enable voice transcription',
      'missing_key'
    );
  }

  const endpoint = options.endpoint ?? GROQ_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const form = new FormData();
  // Bun's FormData accepts a Blob — construct one from the byte array.
  form.append('file', new Blob([audioBytes as unknown as ArrayBuffer]), filename);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'verbose_json');
  if (options.language) {
    form.append('language', options.language);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      throw new TranscriptionError(
        `Transcription timed out after ${String(timeoutMs)}ms`,
        'timeout'
      );
    }
    throw new TranscriptionError(`Transcription network error: ${err.message}`, 'network_error');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new TranscriptionError('Groq rate limit hit — try again in a moment', 'rate_limit', 429);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new TranscriptionError(
      `Groq returned ${String(response.status)}: ${body.slice(0, 200)}`,
      'api_error',
      response.status
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new TranscriptionError(
      `Failed to parse Groq response as JSON: ${(error as Error).message}`,
      'invalid_response'
    );
  }

  if (
    typeof json !== 'object' ||
    json === null ||
    typeof (json as { text?: unknown }).text !== 'string'
  ) {
    throw new TranscriptionError('Groq response missing required `text` field', 'invalid_response');
  }

  const typed = json as { text: string; language?: string };
  getLog().info(
    {
      filename,
      textLength: typed.text.length,
      language: typed.language,
      audioBytes: audioBytes.byteLength,
    },
    'transcription.completed'
  );

  return {
    text: typed.text,
    language: typed.language,
  };
}
