/**
 * Unit tests for Groq Whisper transcription wrapper.
 */
import { describe, test, expect, mock } from 'bun:test';

// Suppress noisy logs during tests.
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

import { transcribeAudio, TranscriptionError } from './transcription';

const AUDIO = new Uint8Array([1, 2, 3, 4]);

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('transcribeAudio', () => {
  test('returns text + language on successful transcription', async () => {
    const fakeFetch = mock(async () =>
      jsonResponse({ text: 'Привіт, це тест', language: 'uk' })
    ) as unknown as typeof fetch;

    const result = await transcribeAudio(AUDIO, 'voice.ogg', {
      apiKey: 'test-key',
      fetchImpl: fakeFetch,
    });

    expect(result.text).toBe('Привіт, це тест');
    expect(result.language).toBe('uk');
  });

  test('throws missing_key error when no API key is set', async () => {
    // Ensure process.env.GROQ_API_KEY doesn't leak in
    const originalKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      await expect(transcribeAudio(AUDIO, 'voice.ogg')).rejects.toMatchObject({
        code: 'missing_key',
      });
    } finally {
      if (originalKey !== undefined) {
        process.env.GROQ_API_KEY = originalKey;
      }
    }
  });

  test('throws rate_limit on HTTP 429', async () => {
    const fakeFetch = mock(
      async () => new Response('rate limit', { status: 429 })
    ) as unknown as typeof fetch;

    try {
      await transcribeAudio(AUDIO, 'voice.ogg', { apiKey: 'k', fetchImpl: fakeFetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as TranscriptionError).code).toBe('rate_limit');
      expect((err as TranscriptionError).httpStatus).toBe(429);
    }
  });

  test('throws api_error on non-2xx non-429 responses', async () => {
    const fakeFetch = mock(
      async () => new Response('boom', { status: 500 })
    ) as unknown as typeof fetch;

    try {
      await transcribeAudio(AUDIO, 'voice.ogg', { apiKey: 'k', fetchImpl: fakeFetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as TranscriptionError).code).toBe('api_error');
      expect((err as TranscriptionError).httpStatus).toBe(500);
    }
  });

  test('throws invalid_response when body has no `text` field', async () => {
    const fakeFetch = mock(async () =>
      jsonResponse({ something: 'else' })
    ) as unknown as typeof fetch;

    try {
      await transcribeAudio(AUDIO, 'voice.ogg', { apiKey: 'k', fetchImpl: fakeFetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as TranscriptionError).code).toBe('invalid_response');
    }
  });

  test('throws timeout when the request is aborted', async () => {
    // Simulate an aborted fetch by rejecting with AbortError
    const fakeFetch = mock(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    try {
      await transcribeAudio(AUDIO, 'voice.ogg', {
        apiKey: 'k',
        fetchImpl: fakeFetch,
        timeoutMs: 10,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as TranscriptionError).code).toBe('timeout');
    }
  });

  test('throws network_error for generic fetch failures', async () => {
    const fakeFetch = mock(async () => {
      throw new Error('ENETUNREACH');
    }) as unknown as typeof fetch;

    try {
      await transcribeAudio(AUDIO, 'voice.ogg', { apiKey: 'k', fetchImpl: fakeFetch });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptionError);
      expect((err as TranscriptionError).code).toBe('network_error');
    }
  });

  test('sends Authorization header and multipart body to Groq endpoint', async () => {
    let capturedUrl: string | URL | Request = '';
    let capturedInit: RequestInit | undefined;
    const fakeFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ text: 'ok' });
    }) as unknown as typeof fetch;

    await transcribeAudio(AUDIO, 'note.ogg', { apiKey: 'sk-xyz', fetchImpl: fakeFetch });

    expect(String(capturedUrl)).toContain('api.groq.com/openai/v1/audio/transcriptions');
    expect(capturedInit?.method).toBe('POST');
    const auth = (capturedInit?.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer sk-xyz');
    // Body is FormData — can't introspect easily, but presence is enough
    expect(capturedInit?.body).toBeDefined();
  });
});
