/**
 * /transcript Command
 *
 * Exports message history between two points as a text file.
 * Walks messages in chronological order and formats them.
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
  type ThreadChannel,
  type Message,
  MessageFlags,
  AttachmentBuilder,
} from 'discord.js'
import { getMessageFromLink } from '../../../infra/discord-utils.js'
import { logger } from '../../../utils/logger.js'

export const transcriptCommand = new SlashCommandBuilder()
  .setName('transcript')
  .setDescription('Export message history between two messages as a text file')
  .addStringOption(opt =>
    opt.setName('start')
      .setDescription('Link to the starting (oldest) message')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('end')
      .setDescription('Link to the ending (newest) message')
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName('limit')
      .setDescription('Maximum messages to include (default: no limit)')
      .setMinValue(1)
      .setRequired(false)
  )

export async function executeTranscript(
  interaction: ChatInputCommandInteraction,
  client: Client,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    const startLink = interaction.options.getString('start', true)
    const endLink = interaction.options.getString('end')
    const limit = interaction.options.getInteger('limit') ?? Infinity

    const startMessage = await getMessageFromLink(client, startLink)
    if (!startMessage) {
      await interaction.editReply({ content: '❌ Could not find the start message.' })
      return
    }

    let endMessage: Message | null = null
    if (endLink) {
      endMessage = await getMessageFromLink(client, endLink)
      if (!endMessage) {
        await interaction.editReply({ content: '❌ Could not find the end message.' })
        return
      }
    }

    const channel = startMessage.channel as TextChannel | ThreadChannel

    // Fetch messages from start to end (or up to limit)
    const messages: Message[] = [startMessage]
    let lastId = startMessage.id
    let remaining = limit - 1

    while (remaining > 0) {
      const batch = await channel.messages.fetch({
        after: lastId,
        limit: Math.min(remaining, 100),
      })

      if (batch.size === 0) break

      // messages.fetch with 'after' returns newest first, we need oldest first
      const sorted = [...batch.values()].reverse()

      for (const msg of sorted) {
        if (endMessage && msg.id === endMessage.id) {
          messages.push(msg)
          remaining = 0
          break
        }
        messages.push(msg)
        remaining--
        if (remaining <= 0) break
      }

      lastId = sorted[sorted.length - 1]!.id

      // If we got fewer than requested, we've hit the end
      if (batch.size < Math.min(remaining + sorted.length, 100)) break
    }

    // Format the transcript
    const lines: string[] = []
    const channelName = 'name' in channel ? channel.name : 'unknown'
    lines.push(`# Transcript of #${channelName}`)
    lines.push(`# ${messages.length} messages, ${startMessage.createdAt.toISOString()} — ${messages[messages.length - 1]?.createdAt.toISOString()}`)
    lines.push('')

    for (const msg of messages) {
      const timestamp = msg.createdAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
      const author = msg.author.displayName || msg.author.username
      const content = msg.content || '[no text content]'

      lines.push(`[${timestamp}] ${author}: ${content}`)

      // Include attachment info
      for (const attachment of msg.attachments.values()) {
        lines.push(`  [attachment: ${attachment.name} (${attachment.contentType})]`)
      }

      // Include embed info
      for (const embed of msg.embeds) {
        if (embed.description) {
          lines.push(`  [embed: ${embed.description.slice(0, 100)}...]`)
        }
      }
    }

    const transcript = lines.join('\n')
    const filename = `transcript-${channelName}-${Date.now()}.txt`

    const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), {
      name: filename,
    })

    logger.info({
      userId: interaction.user.id,
      channelId: channel.id,
      messageCount: messages.length,
    }, 'Transcript exported')

    await interaction.editReply({
      content: `✓ Exported **${messages.length}** messages.`,
      files: [attachment],
    })
  } catch (error) {
    logger.error({ error, userId: interaction.user.id }, 'Error in /transcript command')
    await interaction.editReply({
      content: `❌ Failed to export transcript: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
