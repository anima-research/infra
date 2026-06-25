/**
 * /sleep and /wake — admin-gated infra commands for temporarily muting
 * chapterx bots in a channel.
 *
 * Mechanics:
 *   - /sleep pins a `.sleep <botName>` message with `started_at`, optional
 *     `duration_seconds`, optional `messages`, and optional `reason`. ChapterX
 *     bots honor this locally via their event-driven pin tracker — soma does
 *     not need to talk to chapterx directly.
 *   - A row is also written to `bot_sleeps` so soma can schedule the unpin
 *     when the duration expires (survives soma restarts via the sweeper).
 *   - /wake deletes the row and unpins the message immediately.
 *
 * Only one active sleep per (channel, bot). Re-running /sleep replaces the
 * existing sleep (upsert) — the old pinned message is unpinned as part of the
 * transition.
 *
 * At least one of `duration` / `messages` must be provided. `duration` is
 * always recorded as an `expires_at` (even when messages-only, defaulting to
 * 24h) so the sweeper always cleans up the pin.
 *
 * Hard cap: 24h on any single sleep. Admins can re-run /sleep to extend.
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
  type ThreadChannel,
  type Message,
} from 'discord.js'
import type { Database } from 'better-sqlite3'
import { compileConfigMessage } from '../../../infra/config-message.js'
import { resolveBotTarget } from './bot-target.js'
import { markPinsDirty } from '../../../infra/pin-cache.js'
import { hasAdminRole } from '../admin.js'
import { getOrCreateServer } from '../../../services/user.js'
import { createSleep, removeSleep } from '../../../services/sleeps.js'
import { parseDuration, formatDuration } from '../../../utils/time.js'
import { Emoji, Colors } from '../../embeds/builders.js'
import { logger } from '../../../utils/logger.js'

const MAX_SLEEP_MS = 24 * 60 * 60 * 1000

// Fallback expires_at window for messages-only sleeps — hygiene for the
// sweeper only; chapterx ends the sleep at the message count.
const MESSAGES_ONLY_EXPIRY_MS = 24 * 60 * 60 * 1000

// ============================================================================
// /sleep
// ============================================================================

export const sleepCommand = new SlashCommandBuilder()
  .setName('sleep')
  .setDescription('Temporarily mute a chapterx bot in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName('bot')
      .setDescription('Bot to put to sleep (account or portal bot)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(opt =>
    opt.setName('duration')
      .setDescription('Duration (e.g., 30m, 2h). Max 24h.')
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName('messages')
      .setDescription('Number of non-dot messages (from any author) before wake')
      .setMinValue(1)
      .setMaxValue(10_000)
      .setRequired(false)
  )
  .addStringOption(opt =>
    opt.setName('reason')
      .setDescription('Human-readable reason (optional)')
      .setMaxLength(200)
      .setRequired(false)
  )

export async function executeSleep(
  interaction: ChatInputCommandInteraction,
  db: Database,
  _client: Client,
): Promise<void> {
  if (!hasAdminRole(interaction, db)) {
    logger.warn({
      userId: interaction.user.id,
      command: interaction.commandName,
    }, 'Unauthorized /sleep attempt')
    await interaction.reply({
      content: `${Emoji.CROSS} You don't have permission to use this command.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channel = interaction.channel as TextChannel | ThreadChannel | null
  const serverId = interaction.guildId

  if (!channel || !serverId) {
    await interaction.editReply({
      content: `${Emoji.CROSS} This command must be run in a server text channel.`,
    })
    return
  }

  const rawBot = interaction.options.getString('bot', true).trim()
  const target = resolveBotTarget(interaction, rawBot)
  if (!target) {
    await interaction.editReply({
      content: `${Emoji.CROSS} Could not find a bot matching \`${rawBot}\` in this server. Pick one from autocomplete.`,
    })
    return
  }
  const botKey = target.id
  const botPinTarget = target.pinTarget
  const botDisplay = target.displayName

  const durationStr = interaction.options.getString('duration') ?? undefined
  const messages = interaction.options.getInteger('messages') ?? undefined
  const reason = interaction.options.getString('reason') ?? undefined

  if (!durationStr && messages === undefined) {
    await interaction.editReply({
      content: `${Emoji.CROSS} Provide at least one of \`duration\` or \`messages\`.`,
    })
    return
  }

  let durationMs: number | null = null
  if (durationStr) {
    durationMs = parseDuration(durationStr)
    if (durationMs === null) {
      await interaction.editReply({
        content: `${Emoji.CROSS} Invalid duration \`${durationStr}\`. Use formats like \`30m\`, \`2h\`, \`1d\`.`,
      })
      return
    }
    if (durationMs > MAX_SLEEP_MS) {
      await interaction.editReply({
        content: `${Emoji.CROSS} Duration cannot exceed 24h. Re-run /sleep to extend.`,
      })
      return
    }
  }

  const now = new Date()
  const startedAt = now.toISOString()
  const effectiveMs = durationMs ?? MESSAGES_ONLY_EXPIRY_MS
  const expiresAtDate = new Date(now.getTime() + effectiveMs)
  const expiresAt = expiresAtDate.toISOString()

  const sleepBody: Record<string, unknown> = {
    started_at: startedAt,
  }
  if (durationMs !== null) {
    sleepBody.duration_seconds = Math.round(durationMs / 1000)
  }
  if (messages !== undefined) {
    sleepBody.messages = messages
  }
  if (reason) {
    sleepBody.reason = reason
  }
  const content = compileConfigMessage('sleep', sleepBody, [botPinTarget])

  let sleepMsg: Message
  try {
    sleepMsg = await channel.send(content)
  } catch (error) {
    logger.error({ error, channelId: channel.id, botKey, botDisplay, botKind: target.kind }, 'Failed to send .sleep message')
    await interaction.editReply({
      content: `${Emoji.CROSS} Failed to send .sleep message: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
    return
  }

  try {
    await sleepMsg.pin()
  } catch (error) {
    logger.error({ error, channelId: channel.id, messageId: sleepMsg.id }, 'Failed to pin .sleep message')
    sleepMsg.delete().catch(() => {})
    await interaction.editReply({
      content: `${Emoji.CROSS} Failed to pin .sleep message: ${error instanceof Error ? error.message : 'Unknown error'}. Check bot permissions.`,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const sleepResult = createSleep(db, {
    serverInternalId: server.id,
    channelId: channel.id,
    botName: botKey,
    messageId: sleepMsg.id,
    startedAt,
    expiresAt,
    ...(messages !== undefined ? { messagesInitial: messages } : {}),
    createdBy: interaction.user.id,
    ...(reason ? { reason } : {}),
  })

  if (sleepResult.replacedMessageId) {
    unpinMessageIfPresent(channel, sleepResult.replacedMessageId).catch(err =>
      logger.warn({ err, messageId: sleepResult.replacedMessageId }, 'Failed to unpin replaced .sleep'),
    )
  }

  markPinsDirty(channel.id)

  const gateSummary = [
    durationMs !== null ? formatDuration(durationMs) : null,
    messages !== undefined ? `${messages} message${messages === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' or ')

  logger.info({
    sleepId: sleepResult.id,
    userId: interaction.user.id,
    serverId,
    channelId: channel.id,
    botKey,
    botKind: target.kind,
    botDisplay,
    messageId: sleepMsg.id,
    durationMs,
    messages,
    reason,
    replacedExisting: sleepResult.replacedExisting,
  }, 'Sleep created via /sleep')

  await interaction.editReply({
    content:
      `${Emoji.CHECK} Put **${botDisplay}** to sleep in this channel ` +
      `for ${gateSummary}` +
      (sleepResult.replacedExisting ? ` (replaced previous sleep).` : `.`) +
      `\n→ ${sleepMsg.url}`,
  })

  const expiresTimestamp = Math.floor(expiresAtDate.getTime() / 1000)
  const announcement = new EmbedBuilder()
    .setColor(Colors.WARNING_ORANGE)
    .setTitle(`💤 ${botDisplay} sleeping`)
    .setDescription(
      `**${botDisplay}** will not respond in this channel for ${gateSummary}.` +
      (reason ? `\n\n*${reason}*` : '') +
      `\n\nUse \`/wake bot:${botDisplay}\` to end early.`
    )

  if (durationMs !== null) {
    announcement.addFields({
      name: 'Time gate ends',
      value: `<t:${expiresTimestamp}:R> (<t:${expiresTimestamp}:f>)`,
      inline: true,
    })
  }
  if (messages !== undefined) {
    announcement.addFields({
      name: 'Count gate',
      value: `${messages} message${messages === 1 ? '' : 's'}`,
      inline: true,
    })
  }

  announcement.setTimestamp()

  try {
    await channel.send({ embeds: [announcement] })
  } catch (err) {
    logger.warn({ err, channelId: channel.id }, 'Failed to send sleep announcement')
  }
}

// ============================================================================
// /wake
// ============================================================================

export const wakeCommand = new SlashCommandBuilder()
  .setName('wake')
  .setDescription('Wake a sleeping bot in this channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption(opt =>
    opt.setName('bot')
      .setDescription('Bot to wake')
      .setRequired(true)
      .setAutocomplete(true)
  )

export async function executeWake(
  interaction: ChatInputCommandInteraction,
  db: Database,
  _client: Client,
): Promise<void> {
  if (!hasAdminRole(interaction, db)) {
    logger.warn({
      userId: interaction.user.id,
      command: interaction.commandName,
    }, 'Unauthorized /wake attempt')
    await interaction.reply({
      content: `${Emoji.CROSS} You don't have permission to use this command.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channel = interaction.channel as TextChannel | ThreadChannel | null
  const serverId = interaction.guildId

  if (!channel || !serverId) {
    await interaction.editReply({
      content: `${Emoji.CROSS} This command must be run in a server text channel.`,
    })
    return
  }

  const rawBot = interaction.options.getString('bot', true).trim()
  const target = resolveBotTarget(interaction, rawBot)
  if (!target) {
    await interaction.editReply({
      content: `${Emoji.CROSS} Could not find a bot matching \`${rawBot}\` in this server. Pick one from autocomplete.`,
    })
    return
  }
  const botKey = target.id
  const botDisplay = target.displayName

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)

  const removed = removeSleep(db, server.id, channel.id, botKey)

  if (!removed) {
    await interaction.editReply({
      content: `${Emoji.CROSS} No active sleep for **${botDisplay}** in this channel.`,
    })
    return
  }

  await unpinMessageIfPresent(channel, removed.message_id).catch(err =>
    logger.warn({ err, messageId: removed.message_id }, 'Failed to unpin .sleep on /wake'),
  )
  markPinsDirty(channel.id)

  logger.info({
    sleepId: removed.id,
    userId: interaction.user.id,
    serverId,
    channelId: channel.id,
    botKey,
    botKind: target.kind,
    botDisplay,
    messageId: removed.message_id,
  }, 'Sleep cleared via /wake')

  await interaction.editReply({
    content: `${Emoji.CHECK} Woke **${botDisplay}** up.`,
  })

  const announcement = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`☀️ ${botDisplay} awake`)
    .setDescription(`**${botDisplay}** will respond in this channel again.`)
    .setTimestamp()

  try {
    await channel.send({ embeds: [announcement] })
  } catch (err) {
    logger.warn({ err, channelId: channel.id }, 'Failed to send wake announcement')
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function unpinMessageIfPresent(
  channel: TextChannel | ThreadChannel,
  messageId: string,
): Promise<void> {
  try {
    const msg = await channel.messages.fetch(messageId)
    if (msg?.pinned) {
      await msg.unpin()
    }
  } catch (error) {
    const err = error as { code?: number; message?: string }
    if (err?.code === 10008) return  // Unknown Message
    if (err?.code === 10019) return  // Unknown Webhook (defensive)
    throw error
  }
}
