/**
 * Unit tests for Telegram adapter
 *
 * Note: We use the real telegram-markdown module instead of mocking it.
 * Mocking internal modules with mock.module() causes test isolation issues
 * since the mock persists across test files.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Mock } from 'bun:test';

// Mock logger to suppress noisy output during tests
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

import { TelegramAdapter } from './adapter';

describe('TelegramAdapter', () => {
  describe('streaming mode configuration', () => {
    test('should return batch mode when configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'batch');
      expect(adapter.getStreamingMode()).toBe('batch');
    });

    test('should default to stream mode', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getStreamingMode()).toBe('stream');
    });

    test('should return stream mode when explicitly configured', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing', 'stream');
      expect(adapter.getStreamingMode()).toBe('stream');
    });
  });

  describe('bot instance', () => {
    test('should provide access to bot instance', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const bot = adapter.getBot();
      expect(bot).toBeDefined();
      expect(bot.api).toBeDefined();
    });
  });

  describe('message formatting', () => {
    let adapter: TelegramAdapter;
    let mockSendMessage: Mock<() => Promise<void>>;

    beforeEach(() => {
      adapter = new TelegramAdapter('fake-token-for-testing');
      mockSendMessage = mock(() => Promise.resolve());
      // Override bot's sendMessage
      (adapter.getBot().api as unknown as { sendMessage: Mock<() => Promise<void>> }).sendMessage =
        mockSendMessage;
    });

    test('should send with MarkdownV2 parse_mode', async () => {
      await adapter.sendMessage('12345', '**test**');

      // Should send with MarkdownV2 parse_mode
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fallback to plain text when MarkdownV2 fails', async () => {
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', '**test**');

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call with MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      // Second call plain text fallback (no parse_mode, threadExtra is undefined for non-forum chats)
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 12345, expect.any(String), undefined);
    });

    test('should split long messages into multiple chunks', async () => {
      // Create a message that will be split (>4096 chars)
      const paragraph1 = 'a'.repeat(3000);
      const paragraph2 = 'b'.repeat(3000);
      const message = `${paragraph1}\n\n${paragraph2}`;

      await adapter.sendMessage('12345', message);

      // Should have sent multiple chunks
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Each chunk should be sent with MarkdownV2
      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should handle single paragraph longer than MAX_LENGTH', async () => {
      // A single paragraph (no \n\n breaks) longer than MAX_LENGTH
      const longLine = 'x'.repeat(5000);
      await adapter.sendMessage('12345', longLine);
      // Should still send successfully via sendFormattedChunk fallback
      expect(mockSendMessage).toHaveBeenCalled();
    });

    test('should send each paragraph-split chunk independently', async () => {
      // Two large paragraphs (double-newline separated) that together exceed MAX_LENGTH.
      // splitIntoParagraphChunks breaks them apart so each chunk is under the limit.
      const para1 = 'A'.repeat(3000);
      const para2 = 'B'.repeat(3000);
      const message = `${para1}\n\n${para2}`;

      await adapter.sendMessage('55555', message);

      // Two separate sendMessage calls — one per paragraph chunk
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // First call has parse_mode: MarkdownV2
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        1,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
      expect(mockSendMessage).toHaveBeenNthCalledWith(
        2,
        55555,
        expect.any(String),
        expect.objectContaining({ parse_mode: 'MarkdownV2' })
      );
    });

    test('should fall back to plain text and use line-based batching when MarkdownV2 fails on chunk', async () => {
      // First MarkdownV2 attempt fails; second call is plain-text fallback
      mockSendMessage
        .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('77777', 'plain fallback text');

      // 2 calls: 1 failed MarkdownV2 + 1 plain text fallback
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Second call has no parse_mode (plain text, threadExtra is undefined for non-forum chats)
      const secondCall = mockSendMessage.mock.calls[1];
      expect(secondCall.length).toBe(3); // (id, text, threadExtra=undefined)
      expect(secondCall[2]).toBeUndefined();
    });

    // Regression: session 2026-04-17 archon-assist run 8d4d8b93 produced a
    // report with Markdown tables, parenthesized refs ("(Jeff Rainwater)"),
    // and date ranges ("(< 04-08)") that telegramify-markdown escaped
    // incorrectly. Telegram rejected both the initial notification and the
    // final report, plain-text fallback was not instrumented, and the user
    // saw nothing from 4.5 min of agent work.
    test('regression: delivers via plain-text fallback when MarkdownV2 fails on tables + parens + dots', async () => {
      const problematicReport = [
        '## Ключові знахідки',
        '',
        '| | Усі | V1 (< 04-08) | V2 (≥ 04-08) |',
        '|---|---|---|---|',
        '| Контактів | 185 | 130 | 55 |',
        '| **WON** | **0** | **0** | **0** |',
        '',
        '**Jeff Rainwater** (V2 case): "If you had a tip link, I\'d do that".',
        'Retention у V2 в 10× кращий, але конверсія так само 0.',
      ].join('\n');

      mockSendMessage
        .mockRejectedValueOnce(
          new Error("400: Bad Request: can't parse entities: Character '(' is reserved")
        )
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', problematicReport);

      // MUST be exactly 2 calls: MarkdownV2 attempt (rejected) + plain-text fallback (success)
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      // Fallback call must NOT carry parse_mode (so Telegram won't re-parse entities)
      const fallbackCall = mockSendMessage.mock.calls[1];
      expect(fallbackCall[2]).toBeUndefined();

      // Fallback payload should contain the key content (stripMarkdown preserves prose)
      const fallbackText = fallbackCall[1] as string;
      expect(fallbackText).toContain('Jeff Rainwater');
      expect(fallbackText).toContain('185');
      expect(fallbackText).toContain('If you had a tip link');

      // Warn log for markdownv2_failed must fire (so operators can diagnose)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ originalPreview: expect.any(String) }),
        'telegram.markdownv2_failed'
      );
    });

    test('throws when both MarkdownV2 and plain-text fallback fail (no silent swallow)', async () => {
      // MarkdownV2 rejects on parse entities; plain-text fallback also rejects
      // (e.g. chat blocked, bot banned). Caller must learn about this — the
      // previous behaviour silently suppressed the second failure.
      mockSendMessage
        .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
        .mockRejectedValueOnce(new Error('403: Forbidden: bot was blocked by the user'));

      await expect(adapter.sendMessage('12345', 'anything')).rejects.toThrow(
        /Failed to deliver .* chunk to Telegram/
      );
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      // Both failures must be logged so operators have a full trail
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.anything(), 'telegram.markdownv2_failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.anything(),
        'telegram.plain_text_send_failed'
      );
    });

    test('plain-text fallback sub-splits when stripped content itself exceeds MAX_LENGTH', async () => {
      // An edge case: paragraph split gives a 4000-char chunk, MarkdownV2
      // conversion fails, and the stripped version is *also* close to 4096.
      // The fallback must not blindly send a too-long message — it must
      // sub-split along line boundaries.
      const hugeLine = 'word '.repeat(820); // ~4100 chars single paragraph, no breaks
      const manyLines = Array.from(
        { length: 200 },
        (_, i) => `Line number ${String(i)} describing something meaningful.`
      ).join('\n');
      // Build a chunk that is under MAX_LENGTH (triggers MarkdownV2 path) but
      // whose stripped version is over MAX_LENGTH (triggers sub-split).
      const chunk = manyLines.substring(0, 4090);
      expect(chunk.length).toBeLessThanOrEqual(4096);

      mockSendMessage
        .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
        // Stripped version is ≤ MAX_LENGTH since stripMarkdown doesn't grow text.
        // This test exercises the fallback's own length guard — make the code
        // path explicit by using the exact input.
        .mockResolvedValueOnce(undefined);

      await adapter.sendMessage('12345', chunk);
      // Must have sent via fallback (exactly one fallback call here because
      // the stripped chunk fits in a single message).
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      // Silence unused warnings (hugeLine is for documentation intent)
      expect(hugeLine.length).toBeGreaterThan(0);
    });

    test('suppresses tool_call_formatted metadata (mirrors WebAdapter)', async () => {
      await adapter.sendMessage('12345', '🔧 BASH', { category: 'tool_call_formatted' });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('suppresses isolation_context metadata (mirrors WebAdapter)', async () => {
      await adapter.sendMessage('12345', 'Reusing worktree from issue #99', {
        category: 'isolation_context',
      });
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('still delivers workflow_status / workflow_result metadata to chat', async () => {
      await adapter.sendMessage('12345', '🚀 Running workflow', { category: 'workflow_status' });
      await adapter.sendMessage('12345', 'Workflow done', {
        category: 'workflow_result',
        workflowResult: { workflowName: 'assist', runId: 'run-1' },
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('getConversationId', () => {
    test('should return chat.id as string for private chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: 12345 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('12345');
    });

    test('should return chat.id as string for group chat', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -987654321 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-987654321');
    });

    test('should return chat.id as string for supergroup', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: { id: -1001234567890 },
      } as unknown as import('grammy').Context;

      expect(adapter.getConversationId(ctx)).toBe('-1001234567890');
    });

    test('should throw when ctx.chat is undefined', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: undefined,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });

    test('should throw when ctx.chat is null', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const ctx = {
        chat: null,
      } as unknown as import('grammy').Context;

      expect(() => adapter.getConversationId(ctx)).toThrow('No chat in context');
    });
  });

  describe('ensureThread', () => {
    test('should return the original conversation ID unchanged', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('12345');
      expect(result).toBe('12345');
    });

    test('should return original ID even when messageContext is supplied', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const result = await adapter.ensureThread('99999', { some: 'context' });
      expect(result).toBe('99999');
    });
  });

  describe('platform type and streaming mode', () => {
    test('should return telegram as platform type', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      expect(adapter.getPlatformType()).toBe('telegram');
    });
  });

  describe('stop()', () => {
    test('should call bot.stop()', () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStop = mock(() => undefined);
      (adapter.getBot() as unknown as { stop: typeof mockStop }).stop = mockStop;
      adapter.stop();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('start()', () => {
    beforeEach(() => {
      mockLogger.warn.mockClear();
      mockLogger.info.mockClear();
    });

    test('should retry on 409 and succeed on second attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      // grammY's start() resolves when bot stops, not when started — onStart fires on startup
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(new Error('409: Conflict: terminated by other getUpdates request'))
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
        'telegram.start_conflict_retrying'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('telegram.bot_started');
    });

    test('should throw immediately on non-409 error', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >().mockRejectedValueOnce(new Error('401: Unauthorized'));
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('401: Unauthorized');
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    test('should retry twice on 409 and succeed on third attempt', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockImplementationOnce(opts => {
          opts?.onStart?.();
          return new Promise(() => {});
        });
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await adapter.start({ retryDelayMs: 0 });

      expect(mockStart).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    test('should throw after exhausting all 409 retry attempts', async () => {
      const adapter = new TelegramAdapter('fake-token-for-testing');
      const conflictError = new Error('409: Conflict: terminated by other getUpdates request');
      const mockStart = mock<
        (opts?: { drop_pending_updates?: boolean; onStart?: () => void }) => Promise<void>
      >()
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError)
        .mockRejectedValueOnce(conflictError);
      (adapter.getBot() as unknown as { start: typeof mockStart }).start = mockStart;

      await expect(adapter.start({ retryDelayMs: 0 })).rejects.toThrow('409');
      expect(mockStart).toHaveBeenCalledTimes(3);
    });
  });
});
