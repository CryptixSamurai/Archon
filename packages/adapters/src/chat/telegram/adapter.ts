/**
 * Telegram platform adapter using grammY SDK
 * Handles message sending with 4096 character limit splitting
 */
import { Bot, Context } from 'grammy';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';
import { createLogger } from '@archon/paths';
import { parseAllowedUserIds, isUserAuthorized } from './auth';
import { convertToTelegramMarkdown, stripMarkdown } from './markdown';
import { splitIntoParagraphChunks } from '../../utils/message-splitting';
import type { TelegramMessageContext } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram');
  return cachedLog;
}

const MAX_LENGTH = 4096;

export class TelegramAdapter implements IPlatformAdapter {
  private bot: Bot;
  private streamingMode: 'stream' | 'batch';
  private allowedUserIds: number[];
  private messageHandler: ((ctx: TelegramMessageContext) => Promise<void>) | null = null;

  constructor(token: string, mode: 'stream' | 'batch' = 'stream') {
    // grammY does not impose a handler timeout by default (unlike Telegraf's 90s limit)
    this.bot = new Bot(token);
    this.streamingMode = mode;

    // Parse Telegram user whitelist (optional - empty = open access)
    // Support both TELEGRAM_ALLOWED_USER_IDS and TELEGRAM_ALLOWED_USERS
    this.allowedUserIds = parseAllowedUserIds(
      process.env.TELEGRAM_ALLOWED_USER_IDS ?? process.env.TELEGRAM_ALLOWED_USERS
    );
    if (this.allowedUserIds.length > 0) {
      getLog().info({ userCount: this.allowedUserIds.length }, 'telegram.whitelist_enabled');
    } else {
      getLog().info('telegram.whitelist_disabled');
    }

    getLog().info({ mode }, 'telegram.adapter_initialized');
  }

  /**
   * Send a message to a Telegram chat
   * Automatically splits messages longer than 4096 characters
   *
   * Formatting strategy:
   * - Short messages (≤4096 chars): Convert to MarkdownV2 for nice formatting
   * - Long messages: Split by paragraphs, format each chunk independently
   *   (paragraphs rarely have formatting that spans across them)
   *
   * Forum topic support:
   * - If chatId contains ":" (e.g. "-100123456:789"), the second part is the
   *   message_thread_id and replies go to that specific forum topic.
   */
  async sendMessage(chatId: string, message: string, _metadata?: MessageMetadata): Promise<void> {
    const { numericChatId, threadId } = this.parseChatId(chatId);
    getLog().debug({ chatId, threadId, messageLength: message.length }, 'telegram.send_message');

    if (message.length <= MAX_LENGTH) {
      await this.sendFormattedChunk(numericChatId, message, threadId);
    } else {
      getLog().debug({ messageLength: message.length }, 'telegram.message_splitting');
      const chunks = splitIntoParagraphChunks(message, MAX_LENGTH - 200);

      for (const chunk of chunks) {
        await this.sendFormattedChunk(numericChatId, chunk, threadId);
      }
    }
  }

  /**
   * Parse a chatId that may contain a forum topic thread ID.
   * Format: "chatId" or "chatId:threadId"
   */
  private parseChatId(chatId: string): { numericChatId: number; threadId: number | undefined } {
    const parts = chatId.split(':');
    return {
      numericChatId: parseInt(parts[0]),
      threadId: parts[1] ? parseInt(parts[1]) : undefined,
    };
  }

  /**
   * Send plain text (no parse_mode), splitting on line boundaries when over
   * MAX_LENGTH. Returns true on success, false when any sub-chunk fails —
   * callers treat false as "delivery failed, inform upstream" rather than
   * silently swallowing. Throws are caught and converted into a logged
   * failure so this never bubbles as an unhandled rejection.
   */
  private async sendPlainTextSafe(
    id: number,
    text: string,
    threadExtra: { message_thread_id: number } | undefined,
    context: { reason: string; chunkLength: number; threadId?: number }
  ): Promise<boolean> {
    try {
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(id, text, threadExtra);
        getLog().debug({ ...context, sentLength: text.length }, 'telegram.plain_text_chunk_sent');
        return true;
      }

      // Sub-split by lines, preserving original boundaries.
      const lines = text.split('\n');
      let subChunk = '';
      let subCount = 0;
      for (const line of lines) {
        if (subChunk.length + line.length + 1 > MAX_LENGTH - 100) {
          if (subChunk) {
            await this.bot.api.sendMessage(id, subChunk, threadExtra);
            subCount++;
          }
          subChunk = line;
        } else {
          subChunk += (subChunk ? '\n' : '') + line;
        }
      }
      if (subChunk) {
        await this.bot.api.sendMessage(id, subChunk, threadExtra);
        subCount++;
      }
      getLog().debug(
        { ...context, subChunks: subCount, textLength: text.length },
        'telegram.plain_text_split_sent'
      );
      return true;
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, ...context, textPreview: text.substring(0, 200), textLength: text.length },
        'telegram.plain_text_send_failed'
      );
      return false;
    }
  }

  /**
   * Send a single chunk with MarkdownV2 formatting, with bulletproof
   * fallback to plain text (guarantees the user sees _something_ even when
   * MarkdownV2 escaping has a bug).
   *
   * If threadId is provided, sends to that forum topic.
   */
  private async sendFormattedChunk(id: number, chunk: string, threadId?: number): Promise<void> {
    // Build options: include thread ID only when targeting a forum topic
    const threadExtra = threadId ? { message_thread_id: threadId } : undefined;

    // If chunk is still too long after paragraph splitting, skip MarkdownV2
    // attempt and go straight to plain-text delivery.
    if (chunk.length > MAX_LENGTH) {
      getLog().debug({ chunkLength: chunk.length }, 'telegram.chunk_too_long_plain_text');
      const ok = await this.sendPlainTextSafe(id, stripMarkdown(chunk), threadExtra, {
        reason: 'chunk_too_long',
        chunkLength: chunk.length,
        threadId,
      });
      if (!ok) {
        throw new Error(
          `Failed to deliver ${String(chunk.length)}-char chunk to Telegram (plain text path)`
        );
      }
      return;
    }

    // Try MarkdownV2 formatting
    const formatted = convertToTelegramMarkdown(chunk);
    const markdownOptions = threadExtra
      ? { parse_mode: 'MarkdownV2' as const, ...threadExtra }
      : { parse_mode: 'MarkdownV2' as const };
    try {
      await this.bot.api.sendMessage(id, formatted, markdownOptions);
      getLog().debug({ chunkLength: chunk.length, threadId }, 'telegram.markdownv2_chunk_sent');
    } catch (error) {
      const err = error as Error;
      getLog().warn(
        {
          err,
          originalPreview: chunk.substring(0, 200),
          formattedPreview: formatted.substring(0, 200),
        },
        'telegram.markdownv2_failed'
      );
      const ok = await this.sendPlainTextSafe(id, stripMarkdown(chunk), threadExtra, {
        reason: 'markdownv2_fallback',
        chunkLength: chunk.length,
        threadId,
      });
      if (!ok) {
        // Both paths failed — surface this rather than swallowing, so the
        // caller's retry/logging logic can react.
        throw new Error(
          `Failed to deliver ${String(chunk.length)}-char chunk to Telegram ` +
            '(MarkdownV2 rejected, plain-text fallback also failed)'
        );
      }
    }
  }

  /**
   * Get the grammY bot instance
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Get the configured streaming mode
   */
  getStreamingMode(): 'stream' | 'batch' {
    return this.streamingMode;
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'telegram';
  }

  /**
   * Extract conversation ID from Telegram context.
   * For forum topics (supergroups with topics enabled), includes the thread ID
   * so each topic gets its own conversation: "chatId:threadId".
   * For regular chats/groups, returns just the chat ID.
   */
  getConversationId(ctx: Context): string {
    if (!ctx.chat) {
      throw new Error('No chat in context');
    }
    const chatId = ctx.chat.id.toString();

    // Check for forum topic (message_thread_id present on topic messages)
    const msg = ctx.message;
    if (msg && 'message_thread_id' in msg && msg.message_thread_id) {
      return `${chatId}:${msg.message_thread_id}`;
    }

    return chatId;
  }

  /**
   * Ensure responses go to a thread.
   * For forum topics, the thread is already encoded in the conversation ID.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * Register a message handler for incoming messages
   * Must be called before start()
   */
  onMessage(handler: (ctx: TelegramMessageContext) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Start the bot (begins polling).
   * Makes up to 3 attempts on 409 Conflict (stale getUpdates connection).
   */
  async start(options?: { retryDelayMs?: number }): Promise<void> {
    // Register message handler before launch
    this.bot.on('message:text', ctx => {
      const message = ctx.message.text;
      if (!message) return;

      // Authorization check - verify sender is in whitelist
      const userId = ctx.from?.id;
      if (!isUserAuthorized(userId, this.allowedUserIds)) {
        // Log unauthorized attempt (mask user ID for privacy)
        const maskedId = userId !== undefined ? `${String(userId).slice(0, 4)}***` : 'unknown';
        getLog().info({ maskedUserId: maskedId }, 'telegram.unauthorized_message');
        return; // Silent rejection
      }

      if (this.messageHandler) {
        const conversationId = this.getConversationId(ctx);
        // Debug: log forum topic detection
        const msg = ctx.message;
        const threadId =
          'message_thread_id' in msg
            ? (msg as { message_thread_id?: number }).message_thread_id
            : undefined;
        getLog().info(
          { chatId: ctx.chat?.id, threadId, conversationId, chatType: ctx.chat?.type },
          'telegram.message_received'
        );
        // Fire-and-forget - errors handled by caller
        void this.messageHandler({ conversationId, message, userId });
      } else {
        // Intentional: message dropped silently if handler not registered yet.
        // In production the server always calls onMessage() before start(); this
        // path only surfaces during development or misconfiguration.
        getLog().debug({ chatId: ctx.chat?.id }, 'telegram.message_dropped_no_handler');
      }
    });

    // Retry on 409 Conflict — another getUpdates is still active (Telegram's long-poll timeout is 50s).
    // Wait 60s between attempts to outlast the stale connection. Do NOT recreate the bot instance
    // on each retry — that adds more stale connections rather than fewer.
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = options?.retryDelayMs ?? 60_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // drop_pending_updates: true — discard queued messages from while the bot was offline
        // to avoid reprocessing stale commands after a container restart.
        // grammY's start() resolves only when the bot stops; use onStart callback to detect
        // successful launch and return immediately while the bot continues running in background.
        await new Promise<void>((resolve, reject) => {
          this.bot
            .start({
              drop_pending_updates: true,
              onStart: () => {
                resolve();
              },
            })
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              // Log post-startup crashes — after onStart fires the reject() below is a no-op
              // (Promise already settled), but the error should still be observable in logs.
              getLog().error({ err: error }, 'telegram.bot_runtime_error');
              reject(error);
            });
        });
        getLog().info('telegram.bot_started');
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const is409 = message.includes('409');
        if (is409 && attempt < MAX_ATTEMPTS) {
          getLog().warn(
            { err, attempt, maxAttempts: MAX_ATTEMPTS, retryDelayMs: RETRY_DELAY_MS },
            'telegram.start_conflict_retrying'
          );
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        } else {
          throw err instanceof Error ? err : new Error(message);
        }
      }
    }
  }

  /**
   * Stop the bot gracefully
   */
  stop(): void {
    this.bot.stop();
    getLog().info('telegram.bot_stopped');
  }
}
