/**
 * /soma Admin Commands
 * 
 * Administrative commands for managing the ichor economy
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js'
import type { Database } from 'better-sqlite3'
import { addBalance } from '../../services/balance.js'
import { getOrCreateUser, getOrCreateServer, updateServerConfig } from '../../services/user.js'
import { updateUserServerRoles, getGlobalEffectiveRegenRate, hasGlobalAdminRole, isAdminUserId } from '../../services/roles.js'
import { extractDiscordUserInfo } from '../../services/user.js'
import { generateId } from '../../db/connection.js'
import { createGrantEmbed, Emoji, Colors, formatRegenRate } from '../embeds/builders.js'
import { EmbedBuilder } from 'discord.js'
import { logger } from '../../utils/logger.js'
import { getGlobalConfig, getDefaultServerConfig, updateGlobalConfig, getGlobalConfigInfo } from '../../services/config.js'
import { createCostOverride, getActiveSales, cancelCostOverride, getBotDescription } from '../../services/cost.js'
import { parseDuration, expiresFromNow, formatDuration, formatTimeRemaining } from '../../utils/time.js'
import { DEFAULT_SERVER_CONFIG } from '../../types/index.js'
import { resolveBotTarget } from './infra/bot-target.js'

export const ichorAdminCommand = new SlashCommandBuilder()
  .setName('ichor')
  .setDescription('Ichor economy administration commands')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub
      .setName('grant')
      .setDescription('Grant ichor to a user')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to grant ichor to').setRequired(true))
      .addNumberOption(opt =>
        opt.setName('amount').setDescription('Amount of ichor to grant').setRequired(true).setMinValue(1))
      .addStringOption(opt =>
        opt.setName('reason').setDescription('Reason for the grant').setMaxLength(200)))
  .addSubcommand(sub =>
    sub
      .setName('set-cost')
      .setDescription('Set bot activation cost for this server')
      .addStringOption(opt =>
        opt.setName('bot').setDescription('Bot (account or portal)').setRequired(true).setAutocomplete(true))
      .addNumberOption(opt =>
        opt.setName('cost').setDescription('New cost in ichor').setRequired(true).setMinValue(0))
      .addStringOption(opt =>
        opt.setName('description').setDescription('Bot description for display')))
  .addSubcommand(sub =>
    sub
      .setName('revoke')
      .setDescription('Revoke ichor from a user')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to revoke ichor from').setRequired(true))
      .addNumberOption(opt =>
        opt.setName('amount').setDescription('Amount of ichor to revoke').setRequired(true).setMinValue(1))
      .addStringOption(opt =>
        opt.setName('reason').setDescription('Reason for the revocation').setMaxLength(200)))
  .addSubcommand(sub =>
    sub
      .setName('set-role')
      .setDescription('Configure role multipliers')
      .addRoleOption(opt =>
        opt.setName('role').setDescription('Role to configure').setRequired(true))
      .addNumberOption(opt =>
        opt.setName('regen_multiplier').setDescription('Regeneration multiplier (e.g., 2.0 for 2x)').setMinValue(0.1).setMaxValue(10))
      .addNumberOption(opt =>
        opt.setName('cost_multiplier').setDescription('Cost multiplier (e.g., 0.5 for 50% off)').setMinValue(0).setMaxValue(2)))
  .addSubcommand(sub =>
    sub
      .setName('stats')
      .setDescription('View server-wide statistics'))
  .addSubcommand(sub =>
    sub
      .setName('update-user')
      .setDescription('Force refresh a user\'s role cache')
      .addUserOption(opt =>
        opt.setName('user').setDescription('User to refresh roles for').setRequired(true)))
  // Config subcommands
  .addSubcommand(sub =>
    sub
      .setName('config-view')
      .setDescription('View current server configuration'))
  .addSubcommand(sub =>
    sub
      .setName('config-rewards-emoji')
      .setDescription('Set reward emoji (one or more emoji that give ichor)')
      .addStringOption(opt =>
        opt.setName('emoji')
          .setDescription('Emoji to use for rewards (space-separated for multiple, e.g. "⭐ 🔥 :custom:")')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub
      .setName('config-rewards-amount')
      .setDescription('Set ichor amount per reward reaction')
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Ichor per reward reaction')
          .setRequired(true)
          .setMinValue(0.1)
          .setMaxValue(100)))
  .addSubcommand(sub =>
    sub
      .setName('config-tip-emoji')
      .setDescription('Set tip emoji (single emoji for tipping)')
      .addStringOption(opt =>
        opt.setName('emoji')
          .setDescription('Single emoji to use for tips (can be custom server emoji)')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub
      .setName('config-tip-amount')
      .setDescription('Set ichor amount per tip')
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Ichor transferred per tip')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100)))
  .addSubcommand(sub =>
    sub
      .setName('config-reset')
      .setDescription('Reset server configuration to defaults'))
  // Bounty config subcommands
  .addSubcommand(sub =>
    sub
      .setName('config-bounty-emoji')
      .setDescription('Set bounty emoji (paid star reaction)')
      .addStringOption(opt =>
        opt.setName('emoji')
          .setDescription('Single emoji to use for paid bounties (default: ⭐)')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub
      .setName('config-bounty-cost')
      .setDescription('Set ichor cost per bounty star')
      .addNumberOption(opt =>
        opt.setName('cost')
          .setDescription('Ichor cost per star reaction (default: 50)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1000)))
  .addSubcommand(sub =>
    sub
      .setName('config-bounty-tiers')
      .setDescription('Set bounty tier thresholds and rewards')
      .addIntegerOption(opt =>
        opt.setName('tier1_stars')
          .setDescription('Stars needed for tier 1 (default: 4)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(50))
      .addNumberOption(opt =>
        opt.setName('tier1_reward')
          .setDescription('Ichor reward for tier 1 (default: 500)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(10000))
      .addIntegerOption(opt =>
        opt.setName('tier2_stars')
          .setDescription('Stars needed for tier 2 (default: 7, 0 to disable)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100))
      .addNumberOption(opt =>
        opt.setName('tier2_reward')
          .setDescription('Ichor reward for tier 2 (default: 1500, ignored if tier2_stars is 0)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(50000)))
  // Global config subcommands (affects all servers)
  .addSubcommand(sub =>
    sub
      .setName('global-view')
      .setDescription('View global configuration (affects all servers)'))
  .addSubcommand(sub =>
    sub
      .setName('global-reward-cooldown')
      .setDescription('Set cooldown between free rewards (in minutes)')
      .addIntegerOption(opt =>
        opt.setName('minutes')
          .setDescription('Cooldown in minutes (default: 5, max: 1440 = 24 hours)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(1440)))
  .addSubcommand(sub =>
    sub
      .setName('global-max-daily-rewards')
      .setDescription('Set maximum free rewards per user per day')
      .addIntegerOption(opt =>
        opt.setName('count')
          .setDescription('Max rewards per day (default: 3, 0 = unlimited)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100)))
  .addSubcommand(sub =>
    sub
      .setName('global-cost-multiplier')
      .setDescription('Set global cost multiplier (affects all bot costs across all users)')
      .addNumberOption(opt =>
        opt.setName('multiplier')
          .setDescription('Multiplier (e.g., 0.5 for half price, 2.0 for double)')
          .setRequired(true)
          .setMinValue(0.1)
          .setMaxValue(10)))
  .addSubcommand(sub =>
    sub
      .setName('global-max-daily-sent')
      .setDescription('Set max ichor a user can send per day via transfers/tips')
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Max ichor per day (default: 1000)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100000)))
  .addSubcommand(sub =>
    sub
      .setName('global-max-daily-received')
      .setDescription('Set max ichor a user can receive per day via transfers/tips')
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('Max ichor per day (default: 2000)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100000)))
  .addSubcommand(sub =>
    sub
      .setName('global-reset-balances')
      .setDescription('Reset user balances to a specific value (economy reset)')
      .addNumberOption(opt =>
        opt.setName('amount')
          .setDescription('New balance for all users')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100000))
      .addBooleanOption(opt =>
        opt.setName('confirm')
          .setDescription('You must set this to true to confirm this action')
          .setRequired(true))
      .addRoleOption(opt =>
        opt.setName('role')
          .setDescription('Only reset users with this role (omit to reset ALL users)')))
  // Sale (temporary cost override) subcommands
  .addSubcommand(sub =>
    sub
      .setName('sale')
      .setDescription('Set a temporary reduced cost for a bot')
      .addStringOption(opt =>
        opt.setName('bot').setDescription('Bot (account or portal)').setRequired(true).setAutocomplete(true))
      .addNumberOption(opt =>
        opt.setName('cost').setDescription('Temporary cost in ichor').setRequired(true).setMinValue(0))
      .addStringOption(opt =>
        opt.setName('duration').setDescription('Duration (e.g., 1h, 2d, 3w, 30m)').setRequired(true)))
  .addSubcommand(sub =>
    sub
      .setName('sale-view')
      .setDescription('View active sales in this server'))
  .addSubcommand(sub =>
    sub
      .setName('sale-cancel')
      .setDescription('Cancel an active sale')
      .addStringOption(opt =>
        opt.setName('sale_id').setDescription('Sale ID to cancel (from /ichor sale-view)').setRequired(true)))

/**
 * Check if user has admin access
 * Any of these conditions grants admin access (OR logic):
 * 1. User ID is in SOMA_ADMIN_USERS
 * 2. User has a role in SOMA_ADMIN_ROLES
 * 3. User has Discord Administrator permission (always works as a shortcut)
 * 
 * Works in both server context (checks current roles) and DMs (checks cached roles)
 */
export function hasAdminRole(interaction: ChatInputCommandInteraction, db: Database): boolean {
  const discordUserId = interaction.user.id
  const guildId = interaction.guildId

  // Check if user has Discord Administrator permission (always a valid shortcut)
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    logger.debug({
      discordUserId,
      guildId,
      method: 'discord_admin_permission',
    }, 'Admin access granted via Discord Administrator permission')
    return true
  }

  // Check if user ID is in admin users list
  if (isAdminUserId(discordUserId)) {
    // Logging handled in isAdminUserId
    return true
  }

  // Check admin roles if configured
  const adminRoleIds = process.env.SOMA_ADMIN_ROLES?.split(',').map(r => r.trim()).filter(Boolean) || []
  if (adminRoleIds.length > 0) {
    // In server context, check current roles
    const memberRoles = interaction.member?.roles
    if (memberRoles) {
      // Handle both GuildMemberRoleManager (has cache) and string[] (API response)
      if ('cache' in memberRoles) {
        const matchingRole = memberRoles.cache.find(role => adminRoleIds.includes(role.id))
        if (matchingRole) {
          logger.debug({
            discordUserId,
            guildId,
            roleId: matchingRole.id,
            roleName: matchingRole.name,
            method: 'current_server_role',
          }, 'Admin access granted via current server role')
          return true
        }
      } else if (Array.isArray(memberRoles)) {
        const matchingRoleId = memberRoles.find(roleId => adminRoleIds.includes(roleId))
        if (matchingRoleId) {
          logger.debug({
            discordUserId,
            guildId,
            roleId: matchingRoleId,
            method: 'current_server_role_array',
          }, 'Admin access granted via current server role')
          return true
        }
      }
    }

    // In DMs or as fallback, check global cached roles
    const user = getOrCreateUser(db, interaction.user.id)
    if (hasGlobalAdminRole(db, user.id)) {
      // Logging handled in hasGlobalAdminRole
      return true
    }
  }

  // User doesn't match any admin criteria
  logger.debug({
    discordUserId,
    guildId,
    hasAdminRolesConfigured: adminRoleIds.length > 0,
  }, 'Admin access denied - no matching criteria')
  return false
}

export async function executeIchorAdmin(
  interaction: ChatInputCommandInteraction,
  db: Database,
  _client: Client
): Promise<void> {
  // Check for admin role if SOMA_ADMIN_ROLES is configured
  if (!hasAdminRole(interaction, db)) {
    logger.warn({
      userId: interaction.user.id,
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(),
    }, 'Unauthorized admin command attempt')
    
    await interaction.reply({
      content: `${Emoji.CROSS} You don't have permission to use this command.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const subcommand = interaction.options.getSubcommand()

  switch (subcommand) {
    case 'grant':
      await executeGrant(interaction, db)
      break
    case 'revoke':
      await executeRevoke(interaction, db)
      break
    case 'set-cost':
      await executeSetCost(interaction, db)
      break
    case 'set-role':
      await executeSetRole(interaction, db)
      break
    case 'stats':
      await executeStats(interaction, db)
      break
    case 'update-user':
      await executeUpdateUser(interaction, db)
      break
    case 'config-view':
      await executeConfigView(interaction, db)
      break
    case 'config-rewards-emoji':
      await executeConfigRewardsEmoji(interaction, db)
      break
    case 'config-rewards-amount':
      await executeConfigRewardsAmount(interaction, db)
      break
    case 'config-tip-emoji':
      await executeConfigTipEmoji(interaction, db)
      break
    case 'config-tip-amount':
      await executeConfigTipAmount(interaction, db)
      break
    case 'config-reset':
      await executeConfigReset(interaction, db)
      break
    case 'config-bounty-emoji':
      await executeConfigBountyEmoji(interaction, db)
      break
    case 'config-bounty-cost':
      await executeConfigBountyCost(interaction, db)
      break
    case 'config-bounty-tiers':
      await executeConfigBountyTiers(interaction, db)
      break
    case 'global-view':
      await executeGlobalView(interaction, db)
      break
    case 'global-reward-cooldown':
      await executeGlobalRewardCooldown(interaction, db)
      break
    case 'global-max-daily-rewards':
      await executeGlobalMaxDailyRewards(interaction, db)
      break
    case 'global-cost-multiplier':
      await executeGlobalCostMultiplier(interaction, db)
      break
    case 'global-max-daily-sent':
      await executeGlobalMaxDailySent(interaction, db)
      break
    case 'global-max-daily-received':
      await executeGlobalMaxDailyReceived(interaction, db)
      break
    case 'global-reset-balances':
      await executeGlobalResetBalances(interaction, db)
      break
    case 'sale':
      await executeSale(interaction, db)
      break
    case 'sale-view':
      await executeSaleView(interaction, db)
      break
    case 'sale-cancel':
      await executeSaleCancel(interaction, db)
      break
    default:
      await interaction.reply({
        content: `${Emoji.CROSS} Unknown subcommand.`,
        flags: MessageFlags.Ephemeral,
      })
  }
}

async function executeGrant(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true)
  const amount = interaction.options.getNumber('amount', true)
  const reason = interaction.options.getString('reason')
  const serverId = interaction.guildId

  // Ensure user exists and cache their profile
  const user = getOrCreateUser(db, targetUser.id, extractDiscordUserInfo(targetUser))
  
  // Get server if in guild context, otherwise null (for DM grants)
  const server = serverId 
    ? getOrCreateServer(db, serverId, interaction.guild?.name)
    : null

  // Add balance
  const result = addBalance(db, user.id, amount, server?.id ?? null, 'grant', {
    reason,
    grantedBy: interaction.user.id,
  })

  const embed = createGrantEmbed(targetUser.tag, amount, result.balanceAfter, reason ?? undefined)

  logger.info({
    grantedBy: interaction.user.id,
    targetUser: targetUser.id,
    amount,
    reason,
    newBalance: result.balanceAfter,
    fromDM: !serverId,
  }, 'Admin grant executed')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeRevoke(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true)
  const amount = interaction.options.getNumber('amount', true)
  const reason = interaction.options.getString('reason')
  const serverId = interaction.guildId

  // Ensure user exists and cache their profile
  const user = getOrCreateUser(db, targetUser.id, extractDiscordUserInfo(targetUser))
  
  // Get server if in guild context, otherwise null (for DM revokes)
  const server = serverId 
    ? getOrCreateServer(db, serverId, interaction.guild?.name)
    : null

  // Revoke balance (use addBalance with negative amount and 'revoke' type)
  const result = addBalance(db, user.id, -amount, server?.id ?? null, 'revoke', {
    reason,
    revokedBy: interaction.user.id,
  })

  const embed = new EmbedBuilder()
    .setColor(Colors.WARNING_ORANGE)
    .setTitle(`${Emoji.REVOKE} Ichor Revoked`)
    .setDescription(`Revoked **${amount} ichor** from **${targetUser.tag}**`)
    .addFields({
      name: 'New balance',
      value: `**${result.balanceAfter.toFixed(1)} ichor**`,
    })
    .setTimestamp()

  if (reason) {
    embed.addFields({ name: 'Reason', value: reason })
  }

  logger.info({
    revokedBy: interaction.user.id,
    targetUser: targetUser.id,
    amount,
    reason,
    newBalance: result.balanceAfter,
    fromDM: !serverId,
  }, 'Admin revoke executed')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeSetCost(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const botInput = interaction.options.getString('bot', true)
  const cost = interaction.options.getNumber('cost', true)
  const description = interaction.options.getString('description')
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Resolve to an account bot (Discord user id) or a portal bot (EMS name from
  // the portal-<name> role). target.id is the canonical cost key.
  const target = resolveBotTarget(interaction, botInput)
  if (!target) {
    await interaction.reply({
      content: `${Emoji.CROSS} Could not find a bot matching **${botInput}**. Pick one from the autocomplete list (account bots and portal roles).`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const botId = target.id
  const botName = description || target.displayName
  const server = getOrCreateServer(db, serverId, interaction.guild?.name)

  // Check for existing cost
  const existing = db.prepare(`
    SELECT id, base_cost FROM bot_costs
    WHERE bot_discord_id = ? AND server_id = ?
  `).get(botId, server.id) as { id: string; base_cost: number } | undefined

  let previousCost: number | null = null

  if (existing) {
    previousCost = existing.base_cost
    db.prepare(`
      UPDATE bot_costs SET base_cost = ?, description = ?
      WHERE id = ?
    `).run(cost, botName, existing.id)
  } else {
    db.prepare(`
      INSERT INTO bot_costs (id, bot_discord_id, server_id, base_cost, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(generateId(), botId, server.id, cost, botName)
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Bot Cost Updated`)
    .setDescription(`Set **${botName}** cost to **${cost} ichor** for this server`)
    .setTimestamp()

  if (previousCost !== null) {
    embed.addFields({ name: 'Previous cost', value: `${previousCost} ichor` })
  }

  logger.info({
    setBy: interaction.user.id,
    botId,
    botName,
    cost,
    previousCost,
    serverId: server.id,
  }, 'Admin set-cost executed')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeSetRole(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const role = interaction.options.getRole('role', true)
  const regenMultiplier = interaction.options.getNumber('regen_multiplier')
  const costMultiplier = interaction.options.getNumber('cost_multiplier')
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (regenMultiplier === null && costMultiplier === null) {
    await interaction.reply({
      content: `${Emoji.CROSS} Please provide at least one multiplier to set.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)

  // Check for existing role config
  const existing = db.prepare(`
    SELECT id FROM role_configs
    WHERE server_id = ? AND role_discord_id = ?
  `).get(server.id, role.id) as { id: string } | undefined

  if (existing) {
    // Update existing
    if (regenMultiplier !== null) {
      db.prepare(`
        UPDATE role_configs SET regen_multiplier = ? WHERE id = ?
      `).run(regenMultiplier, existing.id)
    }
    if (costMultiplier !== null) {
      db.prepare(`
        UPDATE role_configs SET cost_multiplier = ? WHERE id = ?
      `).run(costMultiplier, existing.id)
    }
  } else {
    // Create new
    db.prepare(`
      INSERT INTO role_configs (id, server_id, role_discord_id, regen_multiplier, cost_multiplier)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      generateId(),
      server.id,
      role.id,
      regenMultiplier ?? 1.0,
      costMultiplier ?? 1.0
    )
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Role Configured`)
    .setDescription(`Configured **${role.name}** role:`)
    .setTimestamp()

  if (regenMultiplier !== null) {
    embed.addFields({ name: 'Regeneration', value: `**${regenMultiplier}x** faster`, inline: true })
  }
  if (costMultiplier !== null) {
    const discount = costMultiplier < 1 ? `${Math.round((1 - costMultiplier) * 100)}% off` : `${costMultiplier}x cost`
    embed.addFields({ name: 'Costs', value: `**${discount}**`, inline: true })
  }

  logger.info({
    setBy: interaction.user.id,
    roleId: role.id,
    roleName: role.name,
    regenMultiplier,
    costMultiplier,
    serverId: server.id,
  }, 'Admin set-role executed')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeStats(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  getOrCreateServer(db, serverId, interaction.guild?.name)

  // Get total users
  const totalUsers = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as { count: number }

  // Get total ichor in circulation
  const totalIchor = db.prepare(`SELECT SUM(amount) as total FROM balances`).get() as { total: number | null }

  // Get average balance
  const avgBalance = db.prepare(`SELECT AVG(amount) as avg FROM balances`).get() as { avg: number | null }

  // Get 24h activity
  // Format to SQLite's datetime format (YYYY-MM-DD HH:MM:SS) to match datetime('now') storage
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')

  // Get active users in last 24h (users who made any transaction)
  const activeUsers = db.prepare(`
    SELECT COUNT(DISTINCT from_user_id) as count 
    FROM transactions 
    WHERE timestamp >= ?
  `).get(dayAgo) as { count: number }

  const spendCount = db.prepare(`
    SELECT COUNT(*) as count FROM transactions
    WHERE type = 'spend' AND timestamp >= ?
  `).get(dayAgo) as { count: number }

  const transferCount = db.prepare(`
    SELECT COUNT(*) as count FROM transactions
    WHERE type = 'transfer' AND timestamp >= ?
  `).get(dayAgo) as { count: number }

  const tipCount = db.prepare(`
    SELECT COUNT(*) as count FROM transactions
    WHERE type = 'tip' AND timestamp >= ?
  `).get(dayAgo) as { count: number }

  const rewardCount = db.prepare(`
    SELECT COUNT(*) as count FROM transactions
    WHERE type = 'reward' AND timestamp >= ?
  `).get(dayAgo) as { count: number }

  const embed = new EmbedBuilder()
    .setColor(Colors.ICHOR_PURPLE)
    .setTitle(`${Emoji.STATS} Server Statistics`)
    .addFields(
      {
        name: 'Users',
        value: `Total: **${totalUsers.count.toLocaleString()}** | Active (24h): **${activeUsers.count}**`,
      },
      {
        name: 'Ichor Economy',
        value: `Total in circulation: **${(totalIchor.total || 0).toLocaleString()} ichor**\nAverage balance: **${(avgBalance.avg || 0).toFixed(1)} ichor**`,
      },
      {
        name: 'Activity (24h)',
        value: [
          `Bot activations: **${spendCount.count}**`,
          `Transfers: **${transferCount.count}**`,
          `Tips: **${tipCount.count}**`,
          `Rewards: **${rewardCount.count}**`,
        ].join('\n'),
      }
    )
    .setTimestamp()

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeUpdateUser(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const targetUser = interaction.options.getUser('user', true)
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    // Fetch the member to get their current roles
    const guild = interaction.guild!
    const member = await guild.members.fetch(targetUser.id)
    
    // Get role IDs
    const roleIds = Array.from(member.roles.cache.keys())

    // Ensure user and server exist, cache their profile
    const user = getOrCreateUser(db, targetUser.id, extractDiscordUserInfo(targetUser))
    const server = getOrCreateServer(db, serverId, interaction.guild?.name)

    // Update the role cache
    updateUserServerRoles(db, user.id, server.id, roleIds)

    // Get their new effective regen rate
    const globalRegen = getGlobalEffectiveRegenRate(db, user.id)

    const embed = new EmbedBuilder()
      .setColor(Colors.SUCCESS_GREEN)
      .setTitle(`${Emoji.CHECK} Role Cache Updated`)
      .setDescription(`Updated role cache for **${targetUser.tag}**`)
      .addFields(
        {
          name: 'Roles cached',
          value: `${roleIds.length} roles in this server`,
          inline: true,
        },
        {
          name: 'Global regen rate',
          value: `**${globalRegen.rate}**/hour (${globalRegen.multiplier}x)`,
          inline: true,
        }
      )
      .setTimestamp()

    if (globalRegen.bestRoleId) {
      const bestRole = member.roles.cache.get(globalRegen.bestRoleId)
      embed.addFields({
        name: 'Best role',
        value: bestRole ? `**${bestRole.name}**` : `Role ID: ${globalRegen.bestRoleId}`,
      })
    }

    logger.info({
      updatedBy: interaction.user.id,
      targetUser: targetUser.id,
      roleCount: roleIds.length,
      effectiveMultiplier: globalRegen.multiplier,
    }, 'Admin update-user executed')

    await interaction.editReply({
      embeds: [embed],
    })

  } catch (error: any) {
    logger.error({ error, targetUser: targetUser.id }, 'Failed to update user roles')
    
    await interaction.editReply({
      content: `${Emoji.CROSS} Failed to fetch user roles: ${error.message || 'Unknown error'}`,
    })
  }
}

// ============================================================================
// Config Subcommands
// ============================================================================

/**
 * Parse emoji from a string (handles both standard and custom Discord emoji)
 * Custom emoji format: <:name:id> or <a:name:id> for animated
 */
function parseEmoji(input: string): string[] {
  const emoji: string[] = []
  
  // Match custom Discord emoji: <:name:id> or <a:name:id>
  const customEmojiRegex = /<a?:\w+:\d+>/g
  const customMatches = input.match(customEmojiRegex) || []
  emoji.push(...customMatches)
  
  // Remove custom emoji from input to find standard emoji
  let remaining = input.replace(customEmojiRegex, ' ')
  
  // Match standard emoji (unicode emoji) - split by whitespace and filter
  const parts = remaining.split(/\s+/).filter(Boolean)
  for (const part of parts) {
    // Basic validation: standard emoji are usually 1-8 characters
    // and don't contain typical text characters
    if (part.length <= 8 && !/^[a-zA-Z0-9_]+$/.test(part)) {
      emoji.push(part)
    }
  }
  
  return emoji
}

/**
 * Format emoji for display (handles both standard and custom)
 */
function formatEmojiList(emoji: string[]): string {
  return emoji.join(' ')
}

async function executeConfigView(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const config = server.config
  const globalConfig = getGlobalConfig()

  const embed = new EmbedBuilder()
    .setColor(Colors.ICHOR_PURPLE)
    .setTitle(`⚙️ Server Configuration`)
    .setDescription(`Configuration for **${interaction.guild?.name || 'this server'}**`)
    .addFields(
      {
        name: `${Emoji.REWARD} Reward Emoji`,
        value: config.rewardEmoji.length > 0 
          ? formatEmojiList(config.rewardEmoji)
          : '_Not configured_',
        inline: true,
      },
      {
        name: `${Emoji.ICHOR} Reward Amount`,
        value: `**${config.rewardAmount} ichor** per reaction`,
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: true },
      {
        name: `${Emoji.TIP} Tip Emoji`,
        value: config.tipEmoji || '_Not configured_',
        inline: true,
      },
      {
        name: `${Emoji.ICHOR} Tip Amount`,
        value: `**${config.tipAmount} ichor** per tip`,
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: true },
      {
        name: '⭐ Bounty Emoji',
        value: config.bountyEmoji || '⭐',
        inline: true,
      },
      {
        name: '⭐ Bounty Cost',
        value: `**${config.bountyStarCost ?? 50} ichor** per star`,
        inline: true,
      },
      {
        name: '⭐ Bounty Tiers',
        value: (config.bountyTiers || DEFAULT_SERVER_CONFIG.bountyTiers)
          ?.map(t => `${t.threshold}⭐ → ${t.reward} ichor`)
          .join('\n') || '_None configured_',
        inline: true,
      },
      {
        name: '📊 Global Settings (from environment)',
        value: [
          `Base Regen Rate: ${formatRegenRate(globalConfig.baseRegenRate)}`,
          `Max Balance: **${globalConfig.maxBalance}** ichor`,
          `Starting Balance: **${globalConfig.startingBalance}** ichor`,
        ].join('\n'),
      }
    )
    .setTimestamp()

  // Add modification info if available
  if (config.lastModifiedBy) {
    const modifiedAt = config.lastModifiedAt 
      ? `<t:${Math.floor(new Date(config.lastModifiedAt).getTime() / 1000)}:R>`
      : 'Unknown'
    embed.setFooter({ 
      text: `Last modified by ${config.lastModifiedBy}`,
    })
    embed.addFields({
      name: '📝 Last Modified',
      value: `By <@${config.lastModifiedBy}> ${modifiedAt}`,
    })
  }

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigRewardsEmoji(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const emojiInput = interaction.options.getString('emoji', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const parsedEmoji = parseEmoji(emojiInput)

  if (parsedEmoji.length === 0) {
    await interaction.reply({
      content: `${Emoji.CROSS} No valid emoji found. Please provide at least one emoji (e.g., \`⭐\` or \`:custom_emoji:\`).`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (parsedEmoji.length > 10) {
    await interaction.reply({
      content: `${Emoji.CROSS} Too many emoji! Maximum is 10 reward emoji.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousEmoji = server.config.rewardEmoji

  updateServerConfig(db, server.id, { rewardEmoji: parsedEmoji }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Reward Emoji Updated`)
    .setDescription(`Set reward emoji to: ${formatEmojiList(parsedEmoji)}`)
    .addFields({
      name: 'Previous',
      value: previousEmoji.length > 0 ? formatEmojiList(previousEmoji) : '_Default_',
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    emoji: parsedEmoji,
    previousEmoji,
  }, 'Config rewards emoji updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigRewardsAmount(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const amount = interaction.options.getNumber('amount', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousAmount = server.config.rewardAmount

  updateServerConfig(db, server.id, { rewardAmount: amount }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Reward Amount Updated`)
    .setDescription(`Set reward amount to **${amount} ichor** per reaction`)
    .addFields({
      name: 'Previous',
      value: `${previousAmount} ichor`,
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    amount,
    previousAmount,
  }, 'Config rewards amount updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigTipEmoji(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const emojiInput = interaction.options.getString('emoji', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const parsedEmoji = parseEmoji(emojiInput)

  if (parsedEmoji.length === 0) {
    await interaction.reply({
      content: `${Emoji.CROSS} No valid emoji found. Please provide a single emoji (e.g., \`🫀\` or \`:custom_emoji:\`).`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (parsedEmoji.length > 1) {
    await interaction.reply({
      content: `${Emoji.CROSS} Only one tip emoji is allowed. You provided: ${formatEmojiList(parsedEmoji)}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const tipEmoji = parsedEmoji[0]
  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousEmoji = server.config.tipEmoji

  updateServerConfig(db, server.id, { tipEmoji }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Tip Emoji Updated`)
    .setDescription(`Set tip emoji to: ${tipEmoji}`)
    .addFields({
      name: 'Previous',
      value: previousEmoji || '_Default_',
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    emoji: tipEmoji,
    previousEmoji,
  }, 'Config tip emoji updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigTipAmount(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const amount = interaction.options.getNumber('amount', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousAmount = server.config.tipAmount

  updateServerConfig(db, server.id, { tipAmount: amount }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Tip Amount Updated`)
    .setDescription(`Set tip amount to **${amount} ichor** per tip`)
    .addFields({
      name: 'Previous',
      value: `${previousAmount} ichor`,
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    amount,
    previousAmount,
  }, 'Config tip amount updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigReset(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const defaults = getDefaultServerConfig()

  // Reset to defaults but preserve server name and add modification tracking
  updateServerConfig(db, server.id, {
    rewardEmoji: defaults.rewardEmoji,
    rewardAmount: defaults.rewardAmount,
    tipEmoji: defaults.tipEmoji,
    tipAmount: defaults.tipAmount,
    bountyEmoji: defaults.bountyEmoji,
    bountyStarCost: defaults.bountyStarCost,
    bountyTiers: defaults.bountyTiers,
  }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Configuration Reset`)
    .setDescription(`Reset server configuration to defaults:`)
    .addFields(
      {
        name: 'Reward Emoji',
        value: formatEmojiList(DEFAULT_SERVER_CONFIG.rewardEmoji),
        inline: true,
      },
      {
        name: 'Reward Amount',
        value: `${DEFAULT_SERVER_CONFIG.rewardAmount} ichor`,
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: true },
      {
        name: 'Tip Emoji',
        value: DEFAULT_SERVER_CONFIG.tipEmoji,
        inline: true,
      },
      {
        name: 'Tip Amount',
        value: `${DEFAULT_SERVER_CONFIG.tipAmount} ichor`,
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: true },
      {
        name: '⭐ Bounty Emoji',
        value: DEFAULT_SERVER_CONFIG.bountyEmoji || '⭐',
        inline: true,
      },
      {
        name: '⭐ Bounty Cost',
        value: `${DEFAULT_SERVER_CONFIG.bountyStarCost} ichor/star`,
        inline: true,
      },
      {
        name: '⭐ Bounty Tiers',
        value: DEFAULT_SERVER_CONFIG.bountyTiers?.map(t => `${t.threshold}⭐ → ${t.reward} ichor`).join(', ') || 'None',
        inline: true,
      },
    )
    .setTimestamp()

  logger.info({
    resetBy: interaction.user.id,
    serverId: server.id,
  }, 'Config reset to defaults')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

// ============================================================================
// Bounty Config Subcommands
// ============================================================================

async function executeConfigBountyEmoji(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const emojiInput = interaction.options.getString('emoji', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const parsedEmoji = parseEmoji(emojiInput)

  if (parsedEmoji.length === 0) {
    await interaction.reply({
      content: `${Emoji.CROSS} No valid emoji found. Please provide a single emoji (e.g., \`⭐\` or \`:custom_emoji:\`).`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (parsedEmoji.length > 1) {
    await interaction.reply({
      content: `${Emoji.CROSS} Only one bounty emoji is allowed. You provided: ${formatEmojiList(parsedEmoji)}`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const bountyEmoji = parsedEmoji[0]
  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousEmoji = server.config.bountyEmoji || '⭐'

  updateServerConfig(db, server.id, { bountyEmoji }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Bounty Emoji Updated`)
    .setDescription(`Set bounty emoji to: ${bountyEmoji}`)
    .addFields({
      name: 'Previous',
      value: previousEmoji,
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    emoji: bountyEmoji,
    previousEmoji,
  }, 'Config bounty emoji updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigBountyCost(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const cost = interaction.options.getNumber('cost', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousCost = server.config.bountyStarCost ?? 50

  updateServerConfig(db, server.id, { bountyStarCost: cost }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Bounty Cost Updated`)
    .setDescription(`Set bounty star cost to **${cost} ichor** per star`)
    .addFields({
      name: 'Previous',
      value: `${previousCost} ichor`,
    })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    cost,
    previousCost,
  }, 'Config bounty cost updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeConfigBountyTiers(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId
  const tier1Stars = interaction.options.getInteger('tier1_stars', true)
  const tier1Reward = interaction.options.getNumber('tier1_reward', true)
  const tier2Stars = interaction.options.getInteger('tier2_stars', true)
  const tier2Reward = interaction.options.getNumber('tier2_reward', true)

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Build tiers array
  const bountyTiers: Array<{ threshold: number; reward: number }> = [
    { threshold: tier1Stars, reward: tier1Reward },
  ]

  // Only add tier 2 if stars > 0
  if (tier2Stars > 0) {
    if (tier2Stars <= tier1Stars) {
      await interaction.reply({
        content: `${Emoji.CROSS} Tier 2 stars (${tier2Stars}) must be greater than tier 1 stars (${tier1Stars}).`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    bountyTiers.push({ threshold: tier2Stars, reward: tier2Reward })
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const previousTiers = server.config.bountyTiers || DEFAULT_SERVER_CONFIG.bountyTiers

  updateServerConfig(db, server.id, { bountyTiers }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Bounty Tiers Updated`)
    .setDescription(`Set bounty tier thresholds and rewards:`)
    .addFields(
      {
        name: 'New Tiers',
        value: bountyTiers.map((t, i) => `**Tier ${i + 1}:** ${t.threshold}⭐ → ${t.reward} ichor`).join('\n'),
      },
      {
        name: 'Previous Tiers',
        value: previousTiers?.map((t, i) => `Tier ${i + 1}: ${t.threshold}⭐ → ${t.reward} ichor`).join('\n') || 'None',
      }
    )
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    serverId: server.id,
    bountyTiers,
    previousTiers,
  }, 'Config bounty tiers updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

// ============================================================================
// Global Config Subcommands
// ============================================================================

async function executeGlobalView(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const { config, modifiedBy, modifiedAt } = getGlobalConfigInfo(db)

  // Format cooldown nicely
  const cooldownStr = config.rewardCooldownMinutes === 0 
    ? 'Disabled' 
    : config.rewardCooldownMinutes === 1 
      ? '1 minute' 
      : `${config.rewardCooldownMinutes} minutes`

  // Format daily limit
  const dailyLimitStr = config.maxDailyRewards === 0
    ? 'Unlimited'
    : `${config.maxDailyRewards}/day`

  // Format transfer limits
  const maxSentStr = config.maxDailySent === 0 ? 'Unlimited' : `${config.maxDailySent} ichor`
  const maxReceivedStr = config.maxDailyReceived === 0 ? 'Unlimited' : `${config.maxDailyReceived} ichor`

  const embed = new EmbedBuilder()
    .setColor(Colors.ICHOR_PURPLE)
    .setTitle('🌐 Global Configuration')
    .setDescription('These settings affect **all servers and users**.')
    .addFields(
      {
        name: '📊 Economy (from environment)',
        value: [
          `Base Regen Rate: ${formatRegenRate(config.baseRegenRate)}`,
          `Max Balance: **${config.maxBalance}** ichor`,
          `Starting Balance: **${config.startingBalance}** ichor`,
        ].join('\n'),
      },
      {
        name: `${Emoji.REWARD} Free Rewards`,
        value: [
          `Daily Limit: **${dailyLimitStr}**`,
          `Cooldown: **${cooldownStr}** between rewards`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '💰 Global Cost Multiplier',
        value: config.globalCostMultiplier === 1.0 
          ? '**1.0x** (normal pricing)' 
          : `**${config.globalCostMultiplier}x** (${config.globalCostMultiplier < 1 ? 'discount' : 'surcharge'})`,
        inline: true,
      },
      {
        name: '📤 Transfer Limits (per day)',
        value: [
          `Max Send: **${maxSentStr}**`,
          `Max Receive: **${maxReceivedStr}**`,
        ].join('\n'),
        inline: true,
      }
    )
    .setTimestamp()

  if (modifiedBy) {
    const modifiedAtStr = modifiedAt 
      ? `<t:${Math.floor(new Date(modifiedAt).getTime() / 1000)}:R>`
      : 'Unknown'
    embed.setFooter({ text: `Runtime settings last modified by ${modifiedBy}` })
    embed.addFields({
      name: '📝 Last Modified',
      value: `By <@${modifiedBy}> ${modifiedAtStr}`,
    })
  }

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalRewardCooldown(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const minutes = interaction.options.getInteger('minutes', true)
  const previousConfig = getGlobalConfig()
  const previousValue = previousConfig.rewardCooldownMinutes

  updateGlobalConfig(db, {
    rewardCooldownMinutes: minutes,
  }, interaction.user.id)

  // Format nicely
  const formatMinutes = (m: number) => m === 0 ? 'No cooldown' : m === 1 ? '1 minute' : `${m} minutes`

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Reward Cooldown Updated`)
    .setDescription(
      minutes === 0 
        ? '⚠️ Reward cooldown disabled! Users can give all their daily rewards at once.'
        : `Set reward cooldown to **${formatMinutes(minutes)}** between free rewards.`
    )
    .addFields(
      {
        name: 'Previous Value',
        value: formatMinutes(previousValue),
        inline: true,
      },
      {
        name: 'New Value',
        value: formatMinutes(minutes),
        inline: true,
      }
    )
    .setFooter({ text: 'This affects all servers globally' })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    rewardCooldownMinutes: minutes,
    previousValue,
  }, 'Global reward cooldown updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalMaxDailyRewards(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const count = interaction.options.getInteger('count', true)
  const previousConfig = getGlobalConfig()
  const previousValue = previousConfig.maxDailyRewards

  updateGlobalConfig(db, {
    maxDailyRewards: count,
  }, interaction.user.id)

  // Format nicely
  const formatCount = (c: number) => c === 0 ? 'Unlimited' : `${c}/day`

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Max Daily Rewards Updated`)
    .setDescription(
      count === 0 
        ? '⚠️ Daily limit disabled! Users can give unlimited free rewards per day (still subject to cooldown and one per message).'
        : `Set max daily free rewards to **${count}** per user per day.`
    )
    .addFields(
      {
        name: 'Previous Value',
        value: formatCount(previousValue),
        inline: true,
      },
      {
        name: 'New Value',
        value: formatCount(count),
        inline: true,
      },
      {
        name: '💡 Info',
        value: 'Users can still only give one free reward per message. The daily count resets at midnight UTC.',
      }
    )
    .setFooter({ text: 'This affects all servers globally' })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    maxDailyRewards: count,
    previousValue,
  }, 'Global max daily rewards updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalCostMultiplier(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const multiplier = interaction.options.getNumber('multiplier', true)
  const previousConfig = getGlobalConfig()
  const previousValue = previousConfig.globalCostMultiplier

  updateGlobalConfig(db, {
    globalCostMultiplier: multiplier,
  }, interaction.user.id)

  // Format the effect description
  let effectDescription: string
  if (multiplier === 1.0) {
    effectDescription = 'All bot costs return to **normal pricing**.'
  } else if (multiplier < 1.0) {
    const discountPercent = Math.round((1 - multiplier) * 100)
    effectDescription = `All bot costs reduced by **${discountPercent}%** (${multiplier}x multiplier).`
  } else {
    const increasePercent = Math.round((multiplier - 1) * 100)
    effectDescription = `All bot costs increased by **${increasePercent}%** (${multiplier}x multiplier).`
  }

  const embed = new EmbedBuilder()
    .setColor(multiplier < 1 ? Colors.SUCCESS_GREEN : multiplier > 1 ? Colors.WARNING_ORANGE : Colors.ICHOR_PURPLE)
    .setTitle(`${Emoji.CHECK} Global Cost Multiplier Updated`)
    .setDescription(effectDescription)
    .addFields(
      {
        name: 'Previous Value',
        value: `${previousValue}x`,
        inline: true,
      },
      {
        name: 'New Value',
        value: `${multiplier}x`,
        inline: true,
      },
      {
        name: '💡 Example',
        value: `A 10 ichor bot now costs **${(10 * multiplier).toFixed(1)} ichor** (before role discounts).`,
      }
    )
    .setFooter({ text: 'This affects all bot costs across all servers and users' })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    globalCostMultiplier: multiplier,
    previousValue,
  }, 'Global cost multiplier updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalMaxDailySent(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const amount = interaction.options.getNumber('amount', true)
  const previousConfig = getGlobalConfig()
  const previousValue = previousConfig.maxDailySent

  updateGlobalConfig(db, {
    maxDailySent: amount,
  }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Max Daily Sent Updated`)
    .setDescription(
      amount === 0 
        ? '⚠️ Daily send limit disabled! Users can send unlimited ichor per day.'
        : `Set max daily send limit to **${amount} ichor** per user per day.`
    )
    .addFields(
      {
        name: 'Previous Value',
        value: previousValue === 0 ? 'Unlimited' : `${previousValue} ichor`,
        inline: true,
      },
      {
        name: 'New Value',
        value: amount === 0 ? 'Unlimited' : `${amount} ichor`,
        inline: true,
      },
      {
        name: '💡 Info',
        value: 'This limit applies to both `/transfer` commands and 🫀 tip reactions. Limits reset at midnight UTC.',
      }
    )
    .setFooter({ text: 'This affects all servers globally' })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    maxDailySent: amount,
    previousValue,
  }, 'Global max daily sent updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalMaxDailyReceived(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const amount = interaction.options.getNumber('amount', true)
  const previousConfig = getGlobalConfig()
  const previousValue = previousConfig.maxDailyReceived

  updateGlobalConfig(db, {
    maxDailyReceived: amount,
  }, interaction.user.id)

  const embed = new EmbedBuilder()
    .setColor(Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} Max Daily Received Updated`)
    .setDescription(
      amount === 0 
        ? '⚠️ Daily receive limit disabled! Users can receive unlimited ichor per day.'
        : `Set max daily receive limit to **${amount} ichor** per user per day.`
    )
    .addFields(
      {
        name: 'Previous Value',
        value: previousValue === 0 ? 'Unlimited' : `${previousValue} ichor`,
        inline: true,
      },
      {
        name: 'New Value',
        value: amount === 0 ? 'Unlimited' : `${amount} ichor`,
        inline: true,
      },
      {
        name: '💡 Info',
        value: 'This limit applies to both `/transfer` commands and 🫀 tip reactions. Limits reset at midnight UTC.',
      }
    )
    .setFooter({ text: 'This affects all servers globally' })
    .setTimestamp()

  logger.info({
    setBy: interaction.user.id,
    maxDailyReceived: amount,
    previousValue,
  }, 'Global max daily received updated')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeGlobalResetBalances(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const amount = interaction.options.getNumber('amount', true)
  const confirmed = interaction.options.getBoolean('confirm', true)
  const role = interaction.options.getRole('role')

  if (!confirmed) {
    const scope = role ? `balances for role **${role.name}**` : 'all balances'
    await interaction.reply({
      content: `${Emoji.CROSS} You must set \`confirm\` to **True** to reset ${scope}. This action cannot be undone.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  let usersAffected: number
  let beforeStats: { userCount: number; totalIchor: number | null; avgBalance: number | null }

  if (role) {
    const guild = interaction.guild
    if (!guild) {
      await interaction.reply({
        content: `${Emoji.CROSS} This command must be used in a server.`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    const members = await guild.members.fetch()
    const roleMembers = members.filter(m => m.roles.cache.has(role.id))
    const memberIds = roleMembers.map(m => m.id)

    if (memberIds.length === 0) {
      await interaction.editReply({
        content: `${Emoji.CROSS} No members found with role **${role.name}**.`,
      })
      return
    }

    const placeholders = memberIds.map(() => '?').join(',')

    beforeStats = db.prepare(`
      SELECT
        COUNT(*) as userCount,
        SUM(amount) as totalIchor,
        AVG(amount) as avgBalance
      FROM balances
      WHERE user_id IN (
        SELECT id FROM users WHERE discord_id IN (${placeholders})
      )
    `).get(...memberIds) as typeof beforeStats

    const result = db.prepare(`
      UPDATE balances
      SET amount = ?, last_regen_at = datetime('now')
      WHERE user_id IN (
        SELECT id FROM users WHERE discord_id IN (${placeholders})
      )
    `).run(amount, ...memberIds)

    usersAffected = result.changes
  } else {
    beforeStats = db.prepare(`
      SELECT
        COUNT(*) as userCount,
        SUM(amount) as totalIchor,
        AVG(amount) as avgBalance
      FROM balances
    `).get() as typeof beforeStats

    const result = db.prepare(`
      UPDATE balances
      SET amount = ?, last_regen_at = datetime('now')
    `).run(amount)

    usersAffected = result.changes
  }

  const scope = role ? `**${role.name}** role members` : 'All users'
  const embed = new EmbedBuilder()
    .setColor(Colors.WARNING_ORANGE)
    .setTitle(`${Emoji.REVOKE} Economy Reset Complete`)
    .setDescription(`${scope} have been set to **${amount} ichor**.`)
    .addFields(
      {
        name: 'Users Affected',
        value: `**${usersAffected.toLocaleString()}** users`,
        inline: true,
      },
      {
        name: 'Previous Total',
        value: `**${(beforeStats.totalIchor || 0).toLocaleString()}** ichor`,
        inline: true,
      },
      {
        name: 'New Total',
        value: `**${(usersAffected * amount).toLocaleString()}** ichor`,
        inline: true,
      },
      {
        name: 'Previous Average',
        value: `**${(beforeStats.avgBalance || 0).toFixed(1)}** ichor`,
        inline: true,
      },
      {
        name: 'New Balance',
        value: `**${amount}** ichor`,
        inline: true,
      },
      {
        name: '⏱️ Regeneration',
        value: `${role ? 'Affected users\'' : 'All'} regen timers have been reset to now.`,
        inline: true,
      }
    )
    .setFooter({ text: `Reset by ${interaction.user.tag}` })
    .setTimestamp()

  logger.warn({
    resetBy: interaction.user.id,
    newBalance: amount,
    usersAffected,
    previousTotalIchor: beforeStats.totalIchor,
    previousAvgBalance: beforeStats.avgBalance,
    ...(role && { roleId: role.id, roleName: role.name }),
  }, `ECONOMY RESET: ${role ? `Role ${role.name} balances` : 'All balances'} reset`)

  if (role) {
    await interaction.editReply({ embeds: [embed] })
  } else {
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral,
    })
  }
}

// ─── Sale (Temporary Cost Override) Commands ─────────────────────────────────

async function executeSale(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const botInput = interaction.options.getString('bot', true)
  const cost = interaction.options.getNumber('cost', true)
  const durationStr = interaction.options.getString('duration', true)
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Resolve to an account bot (Discord user id) or a portal bot (EMS name from
  // the portal-<name> role). target.id is the canonical cost key.
  const target = resolveBotTarget(interaction, botInput)
  if (!target) {
    await interaction.reply({
      content: `${Emoji.CROSS} Could not find a bot matching **${botInput}**. Pick one from the autocomplete list (account bots and portal roles).`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const botKey = target.id
  const botLabel = target.displayName

  // Parse duration
  const durationMs = parseDuration(durationStr)
  if (durationMs === null) {
    await interaction.reply({
      content: `${Emoji.CROSS} Invalid duration "${durationStr}". Use formats like \`30m\`, \`1h\`, \`2d\`, \`3w\`.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const expiresAt = expiresFromNow(durationStr)
  if (!expiresAt) {
    await interaction.reply({
      content: `${Emoji.CROSS} Could not compute expiration date.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)

  // Get the current base cost for this bot
  const existing = db.prepare(`
    SELECT base_cost FROM bot_costs
    WHERE bot_discord_id = ? AND server_id = ?
  `).get(botKey, server.id) as { base_cost: number } | undefined

  // Fall back to global cost
  const globalCost = existing ? null : db.prepare(`
    SELECT base_cost FROM bot_costs
    WHERE bot_discord_id = ? AND server_id IS NULL
  `).get(botKey) as { base_cost: number } | undefined

  const currentBaseCost = existing?.base_cost ?? globalCost?.base_cost

  if (currentBaseCost === undefined) {
    await interaction.reply({
      content: `${Emoji.CROSS} **${botLabel}** has no cost configured. Set a base cost with \`/ichor set-cost\` first.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (cost === currentBaseCost) {
    await interaction.reply({
      content: `${Emoji.CROSS} Override cost (**${cost}** ichor) is the same as the current base cost. Nothing to change.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Create the override
  const { id: overrideId, replacedExisting } = createCostOverride(
    db,
    botKey,
    server.id,
    cost,
    currentBaseCost,
    interaction.user.id,
    expiresAt
  )

  const isSurge = cost > currentBaseCost
  const pctChange = Math.round(Math.abs(1 - cost / currentBaseCost) * 100)
  const botName = getBotDescription(db, botKey, serverId) || botLabel

  const embed = new EmbedBuilder()
    .setColor(isSurge ? Colors.WARNING_ORANGE : Colors.SUCCESS_GREEN)
    .setTitle(`${Emoji.CHECK} ${isSurge ? 'Surge Started' : 'Sale Started'}`)
    .setDescription(
      `**${botName}** ${isSurge ? 'cost increased' : 'is now on sale'}!\n\n` +
      `~~${currentBaseCost} ichor~~ → **${cost} ichor** (${pctChange}% ${isSurge ? 'increase' : 'off'})`
    )
    .addFields(
      {
        name: 'Duration',
        value: formatDuration(durationMs),
        inline: true,
      },
      {
        name: 'Expires',
        value: `<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>`,
        inline: true,
      },
    )
    .setFooter({ text: replacedExisting ? 'Replaced previous active sale' : `Sale ID: ${overrideId.slice(0, 8)}` })
    .setTimestamp()

  logger.info({
    createdBy: interaction.user.id,
    botId: botKey,
    botName,
    overrideCost: cost,
    originalCost: currentBaseCost,
    duration: durationStr,
    durationMs,
    expiresAt,
    overrideId,
    replacedExisting,
    serverId: server.id,
  }, 'Admin created sale')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })

  // Send a public announcement to the channel
  const expiresTimestamp = Math.floor(new Date(expiresAt).getTime() / 1000)
  const announcement = new EmbedBuilder()
    .setColor(isSurge ? Colors.WARNING_ORANGE : Colors.SUCCESS_GREEN)
    .setTitle(isSurge ? `📈 Price Surge — ${botName}` : `🏷️ Sale — ${botName}`)
    .setDescription(
      isSurge
        ? `**${botName}** cost has been temporarily increased.\n\n` +
          `~~${currentBaseCost} ichor~~ → **${cost} ichor** (+${pctChange}%)\n\n` +
          `Ends <t:${expiresTimestamp}:R> (<t:${expiresTimestamp}:f>)`
        : `**${botName}** is on sale!\n\n` +
          `~~${currentBaseCost} ichor~~ → **${cost} ichor** (${pctChange}% off)\n\n` +
          `Ends <t:${expiresTimestamp}:R> (<t:${expiresTimestamp}:f>)`
    )
    .setTimestamp()

  try {
    if (interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send({ embeds: [announcement] })
    }
  } catch (err) {
    logger.warn({ error: err, channelId: interaction.channelId }, 'Failed to send sale announcement to channel')
  }
}

async function executeSaleView(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const serverId = interaction.guildId

  if (!serverId) {
    await interaction.reply({
      content: `${Emoji.CROSS} This command can only be used in a server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const server = getOrCreateServer(db, serverId, interaction.guild?.name)
  const activeSales = getActiveSales(db, server.id)

  if (activeSales.length === 0) {
    await interaction.reply({
      content: `${Emoji.COSTS} No active sales in this server.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  let description = ''
  for (const sale of activeSales) {
    const botName = getBotDescription(db, sale.bot_discord_id, serverId) || `<@${sale.bot_discord_id}>`
    const remaining = formatTimeRemaining(sale.expires_at)
    const scope = sale.server_id ? 'Server' : 'Global'
    const isSurge = sale.override_cost > sale.original_cost
    const pctChange = Math.round(Math.abs(1 - sale.override_cost / sale.original_cost) * 100)
    const label = isSurge ? `${pctChange}% increase` : `${pctChange}% off`

    description += `**${botName}** — ~~${sale.original_cost}~~ → **${sale.override_cost}** ichor (${label})\n`
    description += `${scope} • ${remaining ? `${remaining} remaining` : 'Expiring...'} • \`${sale.id.slice(0, 8)}\`\n\n`
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.ICHOR_PURPLE)
    .setTitle(`${Emoji.COSTS} Active Sales`)
    .setDescription(description)
    .setFooter({ text: 'Use /ichor sale-cancel with the sale ID to end a sale early' })
    .setTimestamp()

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

async function executeSaleCancel(
  interaction: ChatInputCommandInteraction,
  db: Database
): Promise<void> {
  const saleIdInput = interaction.options.getString('sale_id', true).trim()

  // Support both full IDs and short prefixes
  let cancelled = cancelCostOverride(db, saleIdInput)

  // If not found by exact ID, try prefix match
  if (!cancelled) {
    const match = db.prepare(`
      SELECT id FROM cost_overrides WHERE id LIKE ?
    `).get(`${saleIdInput}%`) as { id: string } | undefined

    if (match) {
      cancelled = cancelCostOverride(db, match.id)
    }
  }

  if (!cancelled) {
    await interaction.reply({
      content: `${Emoji.CROSS} No sale found with ID \`${saleIdInput}\`. Use \`/ichor sale-view\` to see active sales.`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const serverId = interaction.guildId
  const botName = serverId
    ? (getBotDescription(db, cancelled.bot_discord_id, serverId) || `<@${cancelled.bot_discord_id}>`)
    : `<@${cancelled.bot_discord_id}>`

  const embed = new EmbedBuilder()
    .setColor(Colors.WARNING_ORANGE)
    .setTitle(`${Emoji.CHECK} Sale Cancelled`)
    .setDescription(
      `Sale for **${botName}** has been cancelled.\n` +
      `Cost returns to **${cancelled.original_cost} ichor**.`
    )
    .setTimestamp()

  logger.info({
    cancelledBy: interaction.user.id,
    saleId: cancelled.id,
    botDiscordId: cancelled.bot_discord_id,
    overrideCost: cancelled.override_cost,
    originalCost: cancelled.original_cost,
  }, 'Admin cancelled sale')

  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  })
}

