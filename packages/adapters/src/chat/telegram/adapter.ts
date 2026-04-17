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
import { transcribeAudio, TranscriptionError } from './transcription';
import type { TelegramMessageContext } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('adapter.telegram');
  return cachedLog;
}

const MAX_LENGTH = 4096;

/**
 * Conservative per-paragraph chunk size fed to `splitIntoParagraphChunks`.
 *
 * We target half of MAX_LENGTH rather than `MAX_LENGTH - 200` because
 * `convertToTelegramMarkdown` inflates the text with escape backslashes —
 * a row of a Markdown table with parens and dates can grow by 60-80%.
 * Without this buffer, escape-heavy chunks that are well under 4096 chars
 * in source form blow past the limit after conversion and Telegram rejects
 * them with `400: message is too long` BEFORE even parsing entities,
 * triggering the plain-text fallback on every chunk (or silently dropping
 * updates when the fallback itself can't be delivered).
 *
 * 2048 leaves ~2 KB of headroom — enough for the worst escape patterns we've
 * observed (tables + regex-dense prose) while still giving users reasonably
 * sized messages.
 */
const CHUNK_TARGET_SIZE = Math.floor(MAX_LENGTH / 2);

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
      const chunks = splitIntoParagraphChunks(message, CHUNK_TARGET_SIZE);

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
        // info level: delivery outcomes are low-volume + critical for diagnosis.
        getLog().info({ ...context, sentLength: text.length }, 'telegram.plain_text_chunk_sent');
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
      getLog().info(
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
      getLog().info({ chunkLength: chunk.length, threadId }, 'telegram.markdownv2_chunk_sent');
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
   * Route an inbound message (text, or transcribed voice/audio) to the
   * registered `messageHandler`. Handles the common auth + conversation-id
   * + logging path so text and audio sources share one code path.
   */
  private routeIncomingMessage(
    ctx: Context,
    message: string,
    source: 'text' | 'voice' | 'audio' | 'video_note'
  ): void {
    const userId = ctx.from?.id;
    if (!isUserAuthorized(userId, this.allowedUserIds)) {
      const maskedId = userId !== undefined ? `${String(userId).slice(0, 4)}***` : 'unknown';
      getLog().info({ maskedUserId: maskedId, source }, 'telegram.unauthorized_message');
      return; // Silent rejection
    }

    if (!this.messageHandler) {
      // Intentional: message dropped silently if handler not registered yet.
      // In production the server always calls onMessage() before start(); this
      // path only surfaces during development or misconfiguration.
      getLog().debug({ chatId: ctx.chat?.id, source }, 'telegram.message_dropped_no_handler');
      return;
    }

    const conversationId = this.getConversationId(ctx);
    const msg = ctx.message;
    const threadId =
      msg && 'message_thread_id' in msg
        ? (msg as { message_thread_id?: number }).message_thread_id
        : undefined;
    getLog().info(
      { chatId: ctx.chat?.id, threadId, conversationId, chatType: ctx.chat?.type, source },
      'telegram.message_received'
    );
    // Fire-and-forget - errors handled by caller
    void this.messageHandler({ conversationId, message, userId });
  }

  /**
   * Handle incoming voice/audio/video-note: download from Telegram CDN,
   * transcribe via Groq Whisper, send the transcript back to the user as
   * an ACK (so they can catch mistranscription), then route through the
   * normal message pipeline.
   *
   * Transcription failures never silently drop the message — the user
   * always gets a reply (either the transcript or a clear error).
   */
  private async handleAudioMessage(
    ctx: Context,
    kind: 'voice' | 'audio' | 'video_note'
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!isUserAuthorized(userId, this.allowedUserIds)) {
      const maskedId = userId !== undefined ? `${String(userId).slice(0, 4)}***` : 'unknown';
      getLog().info({ maskedUserId: maskedId, kind }, 'telegram.unauthorized_audio');
      return;
    }

    const replyTo = this.getConversationId(ctx);

    // 1. Fetch file metadata (grammY handles getFile API)
    let file: Awaited<ReturnType<typeof ctx.getFile>>;
    try {
      file = await ctx.getFile();
    } catch (err) {
      getLog().error({ err: err as Error, kind }, 'telegram.get_file_failed');
      await this.sendMessage(replyTo, '❌ Could not fetch audio file from Telegram.');
      return;
    }
    if (!file.file_path) {
      getLog().error({ kind, fileId: file.file_id }, 'telegram.get_file_missing_path');
      await this.sendMessage(replyTo, '❌ Telegram did not return a file path for this audio.');
      return;
    }

    // 2. Download audio bytes from Telegram CDN
    const downloadUrl = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    let audioBytes: Uint8Array;
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        throw new Error(`Download HTTP ${String(res.status)}`);
      }
      audioBytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      getLog().error(
        { err: err as Error, kind, filePath: file.file_path },
        'telegram.audio_download_failed'
      );
      await this.sendMessage(replyTo, '❌ Could not download audio file from Telegram.');
      return;
    }

    // 3. Transcribe via Groq Whisper
    //
    // Groq validates file type by filename extension (not content-type).
    // Telegram voice notes arrive with `.oga` (OGG audio, legacy alias),
    // which Groq rejects — its allow-list is flac/mp3/mp4/mpeg/mpga/m4a/
    // ogg/opus/wav/webm. Normalise per message kind so we always present
    // an accepted extension.
    const filename =
      kind === 'voice'
        ? 'voice.ogg' // Telegram voice = OGG/Opus
        : kind === 'video_note'
          ? 'video.mp4' // Video circles are MP4
          : (file.file_path.split('/').pop() ?? 'audio.mp3'); // Regular audio keeps original name

    let transcriptText: string;
    try {
      const result = await transcribeAudio(audioBytes, filename);
      transcriptText = result.text.trim();
      if (!transcriptText) {
        await this.sendMessage(replyTo, '🎙️ Empty transcription — try recording again.');
        return;
      }
    } catch (err) {
      const message = this.formatTranscriptionError(err);
      getLog().warn(
        { err: err as Error, kind, audioBytes: audioBytes.byteLength },
        'telegram.transcription_failed'
      );
      await this.sendMessage(replyTo, message);
      return;
    }

    // 4. ACK with transcript preview so user can catch mistranscription
    const preview =
      transcriptText.length > 500 ? `${transcriptText.slice(0, 500)}…` : transcriptText;
    await this.sendMessage(replyTo, `🎙️ _${preview}_`);

    // 5. Route through normal message pipeline (MarkdownV2 won't apply —
    // transcripts are plain text, so formatting is preserved)
    this.routeIncomingMessage(ctx, transcriptText, kind);
  }

  /** Map a TranscriptionError code to a user-friendly reply. */
  private formatTranscriptionError(err: unknown): string {
    if (err instanceof TranscriptionError) {
      switch (err.code) {
        case 'missing_key':
          return '❌ Voice transcription is not configured (missing GROQ_API_KEY). Please send text instead.';
        case 'rate_limit':
          return '⏳ Transcription rate-limited. Try again in a minute, or send text.';
        case 'timeout':
          return '⏱️ Transcription timed out. Try a shorter recording or send text.';
        case 'network_error':
          return '❌ Transcription network error. Try again, or send text.';
        case 'api_error':
        case 'invalid_response':
        default:
          return '❌ Transcription failed. Please send text instead.';
      }
    }
    return '❌ Unexpected transcription error. Please send text.';
  }

  /**
   * Start the bot (begins polling).
   * Makes up to 3 attempts on 409 Conflict (stale getUpdates connection).
   */
  async start(options?: { retryDelayMs?: number }): Promise<void> {
    // Text handler — delegates to shared router
    this.bot.on('message:text', ctx => {
      const message = ctx.message.text;
      if (!message) return;
      this.routeIncomingMessage(ctx, message, 'text');
    });

    // Voice / audio / video-note handler — transcribe then route
    this.bot.on(['message:voice', 'message:audio', 'message:video_note'], ctx => {
      const kind: 'voice' | 'audio' | 'video_note' = ctx.message?.voice
        ? 'voice'
        : ctx.message?.audio
          ? 'audio'
          : 'video_note';
      // Fire-and-forget: errors are handled inside handleAudioMessage by
      // replying to the user, never re-thrown out of the handler.
      void this.handleAudioMessage(ctx, kind);
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
