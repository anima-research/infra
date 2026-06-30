/**
 * /get_prompt Command
 *
 * Retrieves the assembled LLM prompt for a message via the trace server API.
 * Uses the same API that trace-mcp uses: search → get trace → get request body.
 *
 * Requires TRACE_SERVER_URL and optionally TRACE_SERVER_TOKEN env vars.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js'
import { logger } from '../../../utils/logger.js'

// ============================================================================
// Trace server client (mirrors trace-mcp/src/client.ts)
// ============================================================================

function getTraceServerUrl(): string {
  return process.env.TRACE_SERVER_URL || 'http://localhost:3847'
}

function getTraceServerToken(): string {
  return process.env.TRACE_SERVER_TOKEN || ''
}

async function traceRequest<T>(path: string): Promise<T> {
  const url = `${getTraceServerUrl()}${path}`
  const token = getTraceServerToken()

  const res = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Trace server ${res.status}: ${body}`)
  }

  return (await res.json()) as T
}

// ============================================================================
// Command
// ============================================================================

export const getPromptCommand = new SlashCommandBuilder()
  .setName('get_prompt')
  .setDescription('View the LLM prompt that was sent for a message (from traces)')
  .addStringOption(opt =>
    opt.setName('message_id')
      .setDescription('Message ID or link to look up')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('bot')
      .setDescription('Bot name to filter by (narrows search)')
      .setRequired(false)
      .setAutocomplete(true)
  )
  .addBooleanOption(opt =>
    opt.setName('readable')
      .setDescription('Format as readable conversation transcript instead of raw JSON (default: true)')
      .setRequired(false)
  )

export async function executeGetPrompt(
  interaction: ChatInputCommandInteraction,
  _client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    let messageId = interaction.options.getString('message_id', true)
    const botFilter = interaction.options.getString('bot')

    // Accept both raw message IDs and full Discord URLs. Capture the channel/thread
    // segment too: portal bots key traces by a relay id (`rm_<container>_<msgId>`,
    // container = the thread or channel id), which the trace server matches exactly —
    // so a bare-snowflake search misses. From a full link we can reconstruct that
    // relay id and retry. (Account bots key by the native snowflake, so they match
    // on the first pass.)
    let urlChannelId: string | undefined
    const urlMatch = messageId.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)/)
    if (urlMatch) {
      urlChannelId = urlMatch[1]!
      messageId = urlMatch[2]!
    }

    type SearchResponse = {
      messageId: string
      results: Array<{
        traceId: string
        role: string
        botName: string
        channelName: string
        success: boolean
      }>
      count: number
    }

    const searchTraces = (q: string): Promise<SearchResponse> => {
      const searchParams = new URLSearchParams({ q })
      if (botFilter) searchParams.set('bot', botFilter)
      return traceRequest<SearchResponse>(`/api/search?${searchParams}`)
    }

    // Step 1: search by the bare snowflake (account bots / native ids), then fall
    // back to the reconstructed portal relay id when a link was supplied.
    let searchResult = await searchTraces(messageId)
    if ((!searchResult.results || searchResult.results.length === 0) && urlChannelId) {
      searchResult = await searchTraces(`rm_${urlChannelId}_${messageId}`)
    }

    if (!searchResult.results || searchResult.results.length === 0) {
      const portalHint = urlChannelId
        ? ''
        : '\n- For **portal** bots, paste the full message **link** (not just the ID) — their traces are keyed by channel + message'
      await interaction.editReply({
        content: `❌ No trace found containing message \`${messageId}\`.${botFilter ? ` (searched bot: ${botFilter})` : ''}\n\nTips:\n- The message must have been processed by a ChapterX bot\n- Try specifying the bot name to narrow the search\n- Very old traces may have been cleaned up${portalHint}`,
      })
      return
    }

    // Prefer 'sent' role (bot's response), then 'trigger', then any
    const sorted = searchResult.results.sort((a, b) => {
      const priority = (r: string) => r === 'sent' ? 0 : r === 'trigger' ? 1 : 2
      return priority(a.role) - priority(b.role)
    })
    const match = sorted[0]!

    // Step 2: Get the full trace to find LLM call body refs
    const trace = await traceRequest<Record<string, unknown>>(`/api/trace/${match.traceId}`)

    const llmCalls = trace.llmCalls as Array<Record<string, unknown>> | undefined
    if (!llmCalls || llmCalls.length === 0) {
      await interaction.editReply({
        content: `Found trace **${match.traceId}** for **${match.botName}** but it has no LLM calls (may have been filtered/muted).`,
      })
      return
    }

    const firstCall = llmCalls[0]!
    // The trace server API flattens bodyRefs to top-level fields on each LLM call,
    // while the raw trace file on disk nests them under bodyRefs.
    // Handle both formats for robustness.
    const requestRef = (firstCall.requestBodyRef as string | undefined)
      ?? (firstCall.bodyRefs as Record<string, unknown> | undefined)?.requestBodyRef as string | undefined

    if (!requestRef) {
      await interaction.editReply({
        content: `Found trace **${match.traceId}** for **${match.botName}** but no request body reference was saved.`,
      })
      return
    }

    // Step 3: Get the request body via trace server API
    const requestBody = await traceRequest<Record<string, unknown>>(`/api/request/${encodeURIComponent(requestRef)}`)

    const readable = interaction.options.getBoolean('readable') ?? true
    const model = firstCall.model as string | undefined

    let formatted: string
    let filename: string

    if (readable) {
      formatted = formatPromptReadable(requestBody, model)
      filename = `prompt-${match.botName}-${messageId}.txt`
    } else {
      formatted = JSON.stringify(requestBody, null, 2)
      filename = `prompt-${match.botName}-${messageId}.json`
    }

    const attachment = new AttachmentBuilder(
      Buffer.from(formatted, 'utf-8'),
      { name: filename },
    )

    await interaction.editReply({
      content: `Prompt for **${match.botName}** (trace: ${match.traceId}, model: ${model || 'unknown'}):`,
      files: [attachment],
    })

    logger.info({
      userId: interaction.user.id,
      messageId,
      botName: match.botName,
      traceId: match.traceId,
    }, 'Prompt retrieved via /get_prompt')
  } catch (error) {
    logger.error({ error, userId: interaction.user.id }, 'Error in /get_prompt command')
    await interaction.editReply({
      content: `❌ Failed to retrieve prompt: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

// ============================================================================
// Readable prompt formatter
// ============================================================================

/**
 * Extract text content from a message content field.
 * Handles both string content (prefill mode) and array content (native mode).
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block.type === 'text') return block.text as string
        if (block.type === 'image_url' || block.type === 'image') return '[image]'
        if (block.type === 'tool_use') return `[tool_use: ${block.name}]`
        if (block.type === 'tool_result') return `[tool_result: ${(block.content as string || '').slice(0, 100)}]`
        return `[${block.type}]`
      })
      .join('')
  }
  return String(content ?? '')
}

/**
 * Format an LLM request body as a readable conversation transcript.
 *
 * Handles both Anthropic and OpenAI request formats:
 * - Anthropic: `system` field (string or array) + `messages` with role user/assistant
 * - OpenAI: `messages` with role system/user/assistant
 */
export function formatPromptReadable(body: Record<string, unknown>, model?: string): string {
  const lines: string[] = []

  // Header
  lines.push(`# Prompt — ${model || 'unknown model'}`)
  if (body.temperature !== undefined) lines.push(`# temperature: ${body.temperature}`)
  if (body.max_tokens !== undefined) lines.push(`# max_tokens: ${body.max_tokens}`)
  if (body.max_completion_tokens !== undefined) lines.push(`# max_completion_tokens: ${body.max_completion_tokens}`)

  const stopSeqs = body.stop_sequences ?? body.stop
  if (Array.isArray(stopSeqs) && stopSeqs.length > 0) {
    lines.push(`# stop_sequences: ${stopSeqs.map(s => JSON.stringify(s)).join(', ')}`)
  }
  lines.push('')

  // System prompt
  //  - Anthropic: separate `system` field (string or array of text blocks)
  //  - Gemini:    `systemInstruction.parts[].text`
  //  - OpenAI:    a leading `system` role message, handled in the loop below
  const system = body.system
  const geminiSystem = (body.systemInstruction as { parts?: unknown } | undefined)?.parts
  if (system) {
    lines.push('=== SYSTEM ===')
    if (typeof system === 'string') {
      lines.push(system)
    } else if (Array.isArray(system)) {
      for (const block of system) {
        if (typeof block === 'string') {
          lines.push(block)
        } else if (block.type === 'text') {
          lines.push(block.text as string)
        }
      }
    }
    lines.push('')
  } else if (Array.isArray(geminiSystem)) {
    lines.push('=== SYSTEM ===')
    lines.push(extractGeminiParts(geminiSystem))
    lines.push('')
  }

  // Conversation — request bodies come in four shapes depending on the provider:
  //   Anthropic / OpenAI native → `messages`
  //   Gemini                    → `contents` (role 'user' | 'model', `parts[]`)
  //   base/completion models    → `prompt` (a single pre-rendered string)
  const messages = body.messages as Array<Record<string, unknown>> | undefined
  const contents = body.contents as Array<Record<string, unknown>> | undefined

  if (!messages && Array.isArray(contents)) {
    return formatGeminiContents(lines, contents)
  }
  if (!messages && typeof body.prompt === 'string') {
    // Completions/base models: the formatter already rendered participant labels
    // into a single prefill string — emit it verbatim.
    lines.push('=== CONVERSATION ===')
    lines.push('')
    lines.push('--- prompt ---')
    lines.push(body.prompt)
    lines.push('')
    return lines.join('\n')
  }
  if (!messages) {
    lines.push('[no messages]')
    return lines.join('\n')
  }

  lines.push('=== CONVERSATION ===')
  lines.push('')

  for (const msg of messages) {
    const role = msg.role as string
    const content = extractText(msg.content)

    // OpenAI system messages
    if (role === 'system') {
      lines.push('=== SYSTEM ===')
      lines.push(content)
      lines.push('')
      continue
    }

    // For prefill-mode Anthropic requests, the content is already
    // formatted as "participant: message\nparticipant: message..."
    // so we can just output it directly without adding a role prefix,
    // since the role prefix would be redundant.
    const isPrefill = content.includes('\n') && /^\w[\w\s.]*:/.test(content)

    if (isPrefill) {
      // Content already has participant labels — output as-is
      lines.push(`--- ${role} ---`)
      lines.push(content)
    } else {
      // Native chat format — prefix with role
      lines.push(`[${role}]`)
      lines.push(content)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Extract text from a Gemini `parts[]` array, marking non-text parts.
 * Gemini parts are `{ text }`, `{ inlineData }`, `{ functionCall }`, or
 * `{ functionResponse }`.
 */
function extractGeminiParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p: Record<string, unknown>) => {
      if (typeof p.text === 'string') return p.text
      if (p.inlineData || p.inline_data) return '[image]'
      if (p.functionCall) return `[tool_use: ${(p.functionCall as Record<string, unknown>)?.name ?? ''}]`
      if (p.functionResponse) return '[tool_result]'
      return ''
    })
    .join('')
}

/**
 * Render a Gemini `contents[]` array as a readable transcript. Gemini uses
 * role `'user' | 'model'`; map `model` → `assistant` to match the other formats.
 */
function formatGeminiContents(lines: string[], contents: Array<Record<string, unknown>>): string {
  lines.push('=== CONVERSATION ===')
  lines.push('')
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user'
    lines.push(`[${role}]`)
    lines.push(extractGeminiParts(c.parts))
    lines.push('')
  }
  return lines.join('\n')
}
