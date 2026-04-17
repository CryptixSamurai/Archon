/**
 * Telegram Markdown Converter
 *
 * Converts GitHub-flavored markdown (from AI assistants) to Telegram MarkdownV2 format.
 * Uses telegramify-markdown library for robust conversion.
 */

import telegramifyMarkdown from 'telegramify-markdown';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('telegram-markdown');
  return cachedLog;
}

/**
 * Convert GitHub-flavored markdown to Telegram MarkdownV2 format
 *
 * Transformations:
 * - Headers (##) → Bold (*text*)
 * - **bold** → *bold*
 * - *italic* → _italic_
 * - Lists (- item) → Escaped bullet points
 * - Special characters escaped for MarkdownV2
 *
 * @param markdown - GitHub-flavored markdown text
 * @returns Telegram MarkdownV2 formatted text
 */
export function convertToTelegramMarkdown(markdown: string): string {
  if (!markdown || markdown.trim() === '') {
    return markdown;
  }

  try {
    // 'escape' strategy: escape unsupported tags rather than remove them
    let result = telegramifyMarkdown(markdown, 'escape');

    // Post-processing: Fix remaining **bold** patterns that weren't converted
    // The library sometimes leaves **text** when inside headers like ### **text**
    // MarkdownV2 requires single asterisk *bold* not double **bold**
    result = fixRemainingDoubleBold(result);

    // Post-processing: collapse `\\X` → `\X` for reserved chars inside Markdown
    // tables where telegramify-markdown double-escapes. Without this,
    // Telegram reads `\\` as a literal backslash and then rejects the bare
    // reserved char with 400 "can't parse entities".
    result = fixDoubleEscapedReservedChars(result);

    return result;
  } catch (error) {
    getLog().warn({ err: error }, 'telegram.markdown_conversion_failed');
    return escapeMarkdownV2(markdown);
  }
}

/**
 * Collapse `\\X` → `\X` for MarkdownV2 reserved characters (only outside
 * code blocks and inline code where different escape rules apply).
 *
 * This fixes a bug in `telegramify-markdown` where reserved characters
 * inside Markdown table cells are escaped twice, e.g. a table cell
 * `V1 (< 04-08)` becomes `V1 \\(< 04\\-08\\)` instead of the correct
 * `V1 \(< 04\-08\)`. The double-escape is interpreted by Telegram as
 * "escaped backslash + unescaped paren" → 400 parse error.
 *
 * A preceding `\` is used as a guard to preserve intentional
 * `\\\X` sequences (literal backslash + escaped reserved char).
 */
function fixDoubleEscapedReservedChars(text: string): string {
  const reserved = new Set('_*[]()~`>#+-=|{}.!'.split(''));
  let out = '';
  let i = 0;
  let inCodeBlock = false;
  let inInlineCode = false;

  while (i < text.length) {
    // Toggle on ``` fences (only when not inside inline code)
    if (!inInlineCode && text.substring(i, i + 3) === '```') {
      inCodeBlock = !inCodeBlock;
      out += '```';
      i += 3;
      continue;
    }
    // Toggle on ` inline-code fences (only when not inside a block)
    if (!inCodeBlock && text[i] === '`') {
      inInlineCode = !inInlineCode;
      out += '`';
      i++;
      continue;
    }
    // Inside code — copy verbatim (telegramify handles code-body escaping
    // separately; double-reserved-escape bug is observed only outside code).
    if (inCodeBlock || inInlineCode) {
      out += text[i];
      i++;
      continue;
    }
    // Outside code: detect `\\X` where X is reserved, not preceded by `\`.
    if (
      text[i] === '\\' &&
      text[i + 1] === '\\' &&
      i + 2 < text.length &&
      reserved.has(text[i + 2]) &&
      text[i - 1] !== '\\'
    ) {
      out += '\\' + text[i + 2];
      i += 3;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Fix remaining **bold** patterns that weren't converted by the library
 * Converts **text** to *text* for MarkdownV2 compatibility
 *
 * @param text - Partially converted text
 * @returns Text with all **bold** converted to *bold*
 */
function fixRemainingDoubleBold(text: string): string {
  // Match **text** but not already escaped \*\*
  // Replace with single asterisk *text*
  return text.replace(/(?<!\\)\*\*([^*]+)\*\*/g, '*$1*');
}

/**
 * Escape special characters for Telegram MarkdownV2
 * Used as fallback when conversion fails
 *
 * Characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * @param text - Plain text to escape
 * @returns Text with special characters escaped
 */
export function escapeMarkdownV2(text: string): string {
  // Characters that must be escaped in MarkdownV2
  const specialChars = /([_*[\]()~`>#+\-=|{}.!\\])/g;
  return text.replace(specialChars, '\\$1');
}

/**
 * Check if text appears to be already in MarkdownV2 format
 * (contains escaped characters)
 *
 * @param text - Text to check
 * @returns True if text appears already escaped
 */
export function isAlreadyEscaped(text: string): boolean {
  // Look for patterns like \* \_ \[ etc.
  return /\\[_*[\]()~`>#+\-=|{}.!]/.test(text);
}

/**
 * Strip markdown formatting for plain text display
 * Used for long messages that can't be formatted (would break when split)
 *
 * Removes:
 * - Headers (##, ###, etc.)
 * - Bold (**text** or __text__)
 * - Italic (*text* or _text_)
 * - Strikethrough (~~text~~)
 * - Code blocks (```...```)
 * - Inline code (`code`)
 * - Links [text](url) → text (url)
 *
 * @param markdown - Markdown text to strip
 * @returns Plain text without markdown symbols
 */
export function stripMarkdown(markdown: string): string {
  let result = markdown;

  // Remove code blocks first (preserve content)
  result = result.replace(/```[\s\S]*?```/g, match => {
    // Extract content between ``` markers
    const content = match.replace(/```\w*\n?/g, '').replace(/```$/g, '');
    return content.trim();
  });

  // Remove inline code (preserve content)
  result = result.replace(/`([^`]+)`/g, '$1');

  // Remove headers (##, ###, etc.) - keep the text
  result = result.replace(/^#{1,6}\s+/gm, '');

  // Remove bold **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');

  // Remove italic *text* or _text_ (careful not to match list items)
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1');
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, '$1');

  // Remove strikethrough ~~text~~
  result = result.replace(/~~([^~]+)~~/g, '$1');

  // Convert links [text](url) to text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Clean up multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}
