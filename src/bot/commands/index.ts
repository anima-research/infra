/**
 * Command Registration and Handler
 *
 * Manages slash command registration and routing
 */

import {
  REST,
  Routes,
  type Client,
  type Interaction,
  MessageFlags,
} from 'discord.js'
import type { Database } from 'better-sqlite3'
import { logger } from '../../utils/logger.js'

// Import soma command modules
import { balanceCommand, executeBalance } from './balance.js'
import { transferCommand, executeTransfer } from './transfer.js'
import { costsCommand, executeCosts } from './costs.js'
import { historyCommand, executeHistory } from './history.js'
import { leaderboardCommand, executeLeaderboard } from './leaderboard.js'
import { ichorAdminCommand, executeIchorAdmin } from './admin.js'
import { settingsCommand, executeSettings } from './settings.js'
import { notificationsCommand, executeNotifications } from './notifications.js'
import { helpCommand, executeHelp } from './help.js'
import { handleButton } from '../handlers/buttons.js'
import { handleAutocomplete } from '../handlers/autocomplete.js'

// Import infra command modules
import {
  copyCommand, executeCopy,
  sendCommand, executeSend,
  configCommand, executeConfig,
  configSpeakersCommand, executeConfigSpeakers,
  unsetConfigCommand, executeUnsetConfig,
  getConfigCommand, executeGetConfig,
  historySpliceCommand, executeHistorySplice,
  transcriptCommand, executeTranscript,
  getPromptCommand, executeGetPrompt,
  getContextCommand, executeGetContext,
  forkCommand, executeFork,
  muCommand, executeMu,
  stashCommand, executeStash,
  sleepCommand, executeSleep,
  wakeCommand, executeWake,
  handleLoomButton,
  forkContextMenu,
  forkPrivateContextMenu,
  muContextMenu,
  stashContextMenu,
  handleLoomContextMenu,
} from './infra/index.js'

/** All registered slash commands */
const commands = [
  // Soma (economy) commands
  balanceCommand,
  transferCommand,
  costsCommand,
  historyCommand,
  leaderboardCommand,
  ichorAdminCommand,
  settingsCommand,
  notificationsCommand,
  helpCommand,
  // Infra commands
  copyCommand,
  sendCommand,
  configCommand,
  configSpeakersCommand,
  unsetConfigCommand,
  getConfigCommand,
  historySpliceCommand,
  transcriptCommand,
  getPromptCommand,
  getContextCommand,
  forkCommand,
  muCommand,
  stashCommand,
  sleepCommand,
  wakeCommand,
]

/** Context menu commands */
const contextMenuCommands = [
  forkContextMenu,
  forkPrivateContextMenu,
  muContextMenu,
  stashContextMenu,
]

/**
 * Register slash commands with Discord
 *
 * If SOMA_DEV_GUILD_IDS is set (comma-separated), registers to those guilds (instant)
 * and clears global commands. Also supports legacy SOMA_DEV_GUILD_ID for a single guild.
 * Otherwise registers globally (takes ~1 hour to propagate).
 *
 * This prevents duplicate commands from appearing.
 */
export async function registerCommands(token: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token)

  try {
    const commandData = [
      ...commands.map(cmd => cmd.toJSON()),
      ...contextMenuCommands.map(cmd => cmd.toJSON()),
    ]

    // Get client ID from token
    const base64 = token.split('.')[0]
    const clientId = Buffer.from(base64, 'base64').toString()

    // Check for dev guilds (instant registration)
    // Supports comma-separated list via SOMA_DEV_GUILD_IDS, or single via legacy SOMA_DEV_GUILD_ID
    const devGuildIds = (process.env.SOMA_DEV_GUILD_IDS ?? process.env.SOMA_DEV_GUILD_ID ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)

    // Log which commands we're registering
    const commandNames = commandData.map((c: any) => c.name)
    logger.info({ commands: commandNames }, 'Commands to register')

    if (devGuildIds.length > 0) {
      logger.info({
        commandCount: commandData.length,
        guildIds: devGuildIds,
      }, 'Registering slash commands to dev guilds (instant)...')

      // Register to each dev guild
      for (const guildId of devGuildIds) {
        const result = await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
          body: commandData,
        }) as any[]

        logger.info({
          guildId,
          registeredCount: result.length,
          registeredCommands: result.map(c => c.name),
        }, 'Successfully registered slash commands to dev guild')
      }

      // Clear global commands to prevent duplicates
      logger.info('Clearing global commands to prevent duplicates...')
      await rest.put(Routes.applicationCommands(clientId), {
        body: [],
      })
    } else {
      logger.info({ commandCount: commandData.length }, 'Registering slash commands globally...')

      // Register globally (takes ~1 hour to propagate)
      const result = await rest.put(Routes.applicationCommands(clientId), {
        body: commandData,
      }) as any[]

      logger.info({
        registeredCount: result.length,
        registeredCommands: result.map(c => c.name),
      }, 'Successfully registered slash commands globally (may take up to 1 hour to propagate)')
      logger.info('Note: If you see duplicate commands, clear guild commands with SOMA_CLEAR_GUILD_COMMANDS=<guildId>')
    }

    // Optional: Clear specific guild commands on demand
    const clearGuildId = process.env.SOMA_CLEAR_GUILD_COMMANDS
    if (clearGuildId) {
      logger.info({ guildId: clearGuildId }, 'Clearing guild-specific commands...')
      await rest.put(Routes.applicationGuildCommands(clientId, clearGuildId), {
        body: [],
      })
      logger.info({ guildId: clearGuildId }, 'Guild commands cleared')
    }

  } catch (error) {
    logger.error({ error }, 'Failed to register slash commands')
    throw error
  }
}

/**
 * Handle all interaction events
 */
export async function handleInteraction(
  interaction: Interaction,
  db: Database,
  client: Client
): Promise<void> {
  try {
    // Chat input commands (slash commands)
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction, db, client)
      return
    }

    // Message context menu commands (right-click on message)
    if (interaction.isMessageContextMenuCommand()) {
      await handleLoomContextMenu(interaction, client)
      return
    }

    // Button interactions
    if (interaction.isButton()) {
      // Try loom buttons first (fork_button|...)
      const handledByLoom = await handleLoomButton(interaction, client)
      if (handledByLoom) return
      // Fall through to soma button handler
      await handleButton(interaction, db, client)
      return
    }

    // Autocomplete
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, db)
      return
    }

    // Modal submissions are handled in specific command flows

  } catch (error) {
    logger.error({
      error,
      interactionType: interaction.type,
      userId: interaction.user.id,
    }, 'Error handling interaction')

    // Try to respond with error if we haven't already
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      try {
        await interaction.reply({
          content: '⚠️ Something went wrong. Please try again in a moment.',
          flags: MessageFlags.Ephemeral,
        })
      } catch {
        // Ignore if we can't reply
      }
    }
  }
}

/**
 * Route slash commands to their handlers
 */
async function handleCommand(
  interaction: Interaction,
  db: Database,
  client: Client
): Promise<void> {
  if (!interaction.isChatInputCommand()) return

  const { commandName } = interaction

  logger.debug({
    command: commandName,
    userId: interaction.user.id,
    guildId: interaction.guildId,
  }, 'Handling command')

  switch (commandName) {
    // === Soma (economy) commands ===
    case 'balance':
      await executeBalance(interaction, db)
      break
    case 'transfer':
      await executeTransfer(interaction, db, client)
      break
    case 'costs':
      await executeCosts(interaction, db)
      break
    case 'history':
      await executeHistory(interaction, db)
      break
    case 'leaderboard':
      await executeLeaderboard(interaction, db)
      break
    case 'ichor':
      await executeIchorAdmin(interaction, db, client)
      break
    case 'settings':
      await executeSettings(interaction, db)
      break
    case 'notifications':
      await executeNotifications(interaction, db)
      break
    case 'help':
      await executeHelp(interaction, db)
      break

    // === Infra commands ===
    case 'fork':
      await executeFork(interaction, client)
      break
    case 'mu':
      await executeMu(interaction, client)
      break
    case 'stash':
      await executeStash(interaction, client)
      break
    case 'copy':
      await executeCopy(interaction, client)
      break
    case 'send':
      await executeSend(interaction, client)
      break
    case 'config':
      await executeConfig(interaction)
      break
    case 'config_speakers':
      await executeConfigSpeakers(interaction)
      break
    case 'unset_config':
      await executeUnsetConfig(interaction)
      break
    case 'get_config':
      await executeGetConfig(interaction)
      break
    case 'history_splice':
      await executeHistorySplice(interaction)
      break
    case 'transcript':
      await executeTranscript(interaction, client)
      break
    case 'get_prompt':
      await executeGetPrompt(interaction, client)
      break
    case 'get_context':
      await executeGetContext(interaction, client)
      break
    case 'sleep':
      await executeSleep(interaction, db, client)
      break
    case 'wake':
      await executeWake(interaction, db, client)
      break

    default:
      logger.warn({ commandName }, 'Unknown command')
      await interaction.reply({
        content: '❌ Unknown command.',
        flags: MessageFlags.Ephemeral,
      })
  }
}
