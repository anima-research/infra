/**
 * Autocomplete Handler
 * 
 * Provides autocomplete suggestions for command options
 */

import { type AutocompleteInteraction } from 'discord.js'
import type { Database } from 'better-sqlite3'
import type { BotCostRow } from '../../types/index.js'
import { getOrCreateServer } from '../../services/user.js'
import { autocompleteBotNames, autocompleteConfigKeys } from '../commands/infra/get-config.js'
import { botTargetChoices } from '../commands/infra/bot-target.js'
import { logger } from '../../utils/logger.js'

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  db: Database
): Promise<void> {
  const { commandName, options } = interaction
  const focused = options.getFocused(true)

  logger.debug({
    commandName,
    focusedName: focused.name,
    focusedValue: focused.value,
  }, 'Handling autocomplete')

  // Bot autocomplete for /costs and /soma set-cost (from DB)
  if (focused.name === 'bot' && (commandName === 'costs' || commandName === 'soma')) {
    await handleBotAutocomplete(interaction, db, focused.value)
    return
  }

  // Bot autocomplete for /get_config, /get_prompt (from EMS filesystem —
  // these need access to bot config YAML files, so the EMS directory name is
  // the right key).
  if (
    focused.name === 'bot' &&
    (
      commandName === 'get_config'
      || commandName === 'get_prompt'
    )
  ) {
    const choices = autocompleteBotNames(focused.value)
    await interaction.respond(choices)
    return
  }

  // Bot autocomplete for /sleep, /wake — account bot members AND portal-bot
  // roles in this guild. The submitted value is the Discord snowflake (user id
  // for account bots, role id for portal bots), so the command resolves it to a
  // `<@id>` or `<@&roleId>` mention that ChapterX matches against pins.
  if (
    focused.name === 'bot' &&
    (commandName === 'sleep' || commandName === 'wake')
  ) {
    await interaction.respond(botTargetChoices(interaction, focused.value))
    return
  }

  // Bot autocomplete for /ichor set-cost and /ichor sale — account bot members
  // AND portal-bot roles (mirrors /sleep, /wake). The submitted value is the
  // Discord snowflake (user id for account, portal role id), which
  // resolveBotTarget maps to the cost key (user id for account, EMS name for
  // portal) in the command handlers.
  if (
    focused.name === 'bot' &&
    commandName === 'ichor' &&
    (options.getSubcommand(false) === 'set-cost' || options.getSubcommand(false) === 'sale')
  ) {
    await interaction.respond(botTargetChoices(interaction, focused.value))
    return
  }

  // Config property autocomplete for /get_config
  if (focused.name === 'property' && commandName === 'get_config') {
    const choices = autocompleteConfigKeys(focused.value)
    await interaction.respond(choices)
    return
  }

  // Config key autocomplete for /config custom_key
  if (focused.name === 'custom_key' && commandName === 'config') {
    const choices = autocompleteConfigKeys(focused.value)
    await interaction.respond(choices)
    return
  }

  // Default: return empty
  await interaction.respond([])
}

async function handleBotAutocomplete(
  interaction: AutocompleteInteraction,
  db: Database,
  query: string
): Promise<void> {
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.respond([])
    return
  }

  const server = getOrCreateServer(db, serverId)

  // Search for bots matching the query
  const bots = db.prepare(`
    SELECT bot_discord_id, base_cost, description
    FROM bot_costs
    WHERE (server_id = ? OR server_id IS NULL)
    AND (
      bot_discord_id LIKE ?
      OR description LIKE ?
    )
    ORDER BY base_cost ASC
    LIMIT 25
  `).all(server.id, `%${query}%`, `%${query}%`) as BotCostRow[]

  const choices = bots.map(bot => ({
    name: `${bot.description || bot.bot_discord_id} (${bot.base_cost} ichor)`,
    value: bot.bot_discord_id,
  }))

  await interaction.respond(choices)
}


