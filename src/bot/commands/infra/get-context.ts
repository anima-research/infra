/**
 * /get_context Command
 *
 * Builds and returns the full LLM context for the current channel via the
 * ChapterX API. Unlike /get_prompt (which retrieves a past prompt from traces),
 * this builds the context *right now* — useful for debugging what the bot would
 * see if it were activated.
 *
 * Requires CHAPTERX_API_URL and CHAPTERX_API_TOKEN env vars.
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
// ChapterX API client
// ============================================================================

function getChapterxApiUrl(): string {
  return process.env.CHAPTERX_API_URL || ''
}

function getChapterxApiToken(): string {
  return process.env.CHAPTERX_API_TOKEN || ''
}

async function chapterxRequest<T>(path: string, body: unknown): Promise<T> {
  const baseUrl = getChapterxApiUrl()
  if (!baseUrl) throw new Error('CHAPTERX_API_URL not configured')

  const token = getChapterxApiToken()
  if (!token) throw new Error('CHAPTERX_API_TOKEN not configured')

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000), // context build can be slow
  })

  if (!res.ok) {
    let errorMsg: string
    try {
      const error = (await res.json()) as Record<string, unknown>
      errorMsg = (error.message as string) || res.statusText
    } catch {
      errorMsg = res.statusText
    }
    throw new Error(`ChapterX API ${res.status}: ${errorMsg}`)
  }

  return (await res.json()) as T
}

// ============================================================================
// Command
// ============================================================================

export const getContextCommand = new SlashCommandBuilder()
  .setName('get_context')
  .setDescription('Build and view the current LLM context for this channel')
  .addIntegerOption(opt =>
    opt.setName('messages')
      .setDescription('Number of messages to include (default: bot config)')
      .setRequired(false)
  )

interface ContextMessage {
  participant: string
  content: string
  hasImages: boolean
  imageCount: number
}

interface ContextResult {
  messages: ContextMessage[]
  metadata: {
    botName: string
    channelId: string
    messageCount: number
    configuredLimit: number
    requestedLimit: number | null
    model: string
    mode: string
    systemPrompt: string | null
    contextPrefix: string | null
    stopSequences: string[]
  }
}

export async function executeGetContext(
  interaction: ChatInputCommandInteraction,
  _client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    const channelId = interaction.channelId
    const messages = interaction.options.getInteger('messages') ?? undefined

    const result = await chapterxRequest<ContextResult>('/api/context/build', {
      channel: channelId,
      messages,
    })

    // Format as readable text file
    const lines: string[] = []

    // Header
    lines.push(`# LLM Context for ${result.metadata.botName}`)
    lines.push(`# Channel: ${channelId}`)
    lines.push(`# Messages: ${result.metadata.messageCount}`)
    lines.push(`# Model: ${result.metadata.model}`)
    lines.push(`# Mode: ${result.metadata.mode}`)
    if (result.metadata.configuredLimit) {
      lines.push(`# Configured limit: ${result.metadata.configuredLimit} messages`)
    }
    if (result.metadata.requestedLimit) {
      lines.push(`# Requested limit: ${result.metadata.requestedLimit} messages`)
    }
    if (result.metadata.systemPrompt) {
      lines.push(`# System prompt: ${result.metadata.systemPrompt}`)
    }
    if (result.metadata.contextPrefix) {
      lines.push(`# Context prefix: ${result.metadata.contextPrefix}`)
    }
    if (result.metadata.stopSequences?.length) {
      lines.push(`# Stop sequences: ${result.metadata.stopSequences.map(s => JSON.stringify(s)).join(', ')}`)
    }
    lines.push('')

    // Messages
    for (const msg of result.messages) {
      lines.push(`--- ${msg.participant} ---`)
      lines.push(msg.content)
      if (msg.hasImages) {
        lines.push(`[${msg.imageCount} image(s)]`)
      }
      lines.push('')
    }

    const textContent = lines.join('\n')
    const attachment = new AttachmentBuilder(
      Buffer.from(textContent, 'utf-8'),
      { name: `context-${result.metadata.botName}-${channelId}.txt` },
    )

    await interaction.editReply({
      content: `Context for **${result.metadata.botName}** (${result.metadata.messageCount} messages, model: \`${result.metadata.model}\`):`,
      files: [attachment],
    })

    logger.info({
      userId: interaction.user.id,
      channelId,
      botName: result.metadata.botName,
      messageCount: result.metadata.messageCount,
    }, 'Context retrieved via /get_context')
  } catch (error) {
    logger.error({ error, userId: interaction.user.id }, 'Error in /get_context command')
    await interaction.editReply({
      content: `Failed to build context: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
