/**
 * Shared bot-target resolution for admin commands that act on a chapterx bot.
 *
 * Two kinds of bot exist in a guild:
 *   - **account** — a normal chapterx bot with its own Discord bot account
 *     (a guild member where `user.bot === true`). Addressed via `<@userId>`.
 *   - **portal** — a bot served through the shared portal relay, which has NO
 *     Discord account. It is represented in the guild by a manually-created
 *     role named `portal-<emsName>` (e.g. `portal-glm52`) used for selection.
 *     In a pinned `.sleep`/`.config`, chapterx matches a portal persona by its
 *     EMS/config name (e.g. `glm52`), NOT by role mention (a role mention
 *     `<@&id>` matches none of a bot's identity fields) — so the pin target is
 *     the bare EMS name (the role's `portal-` prefix stripped).
 *
 * Commands should resolve their `bot` option through {@link resolveBotTarget}
 * and feed autocomplete from {@link botTargetChoices}, rather than assuming the
 * target has a Discord account.
 *
 * NOTE: the portal `emsName` is derived from the role name (strip the
 * `portal-` prefix), correct for the current convention (`portal-glm52` ->
 * `glm52`). A runtime `roleId -> emsName` override map (for roles whose name
 * diverges from the EMS dir, or duplicate role names) is deferred until a bot
 * needs it.
 */

import {
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type Role,
  type GuildMember,
} from 'discord.js'

/** Naming convention for per-bot portal roles in the guild. */
export const PORTAL_ROLE_PREFIX = 'portal-'

export type BotTargetKind = 'account' | 'portal'

export interface BotTarget {
  kind: BotTargetKind
  /** Canonical storage key: Discord user id (account) or EMS name (portal). */
  id: string
  /**
   * Target token to embed in a pinned .config/.sleep message so chapterx
   * matches it: a `<@userId>` mention for account bots, or the bare EMS bot
   * name for portal bots (chapterx matches portal personas by botId / config
   * name, not by role mention).
   */
  pinTarget: string
  /** Canonical chapterx bot name (EMS dir). Portal: role name minus prefix. */
  emsName: string
  /**
   * Human-facing label for command responses and announcements. Account: the
   * member's guild display name. Portal: the clean EMS name (role name minus
   * the `portal-` prefix) — the prefix is plumbing and must not leak into
   * user-facing text.
   */
  displayName: string
}

/** Strip the `portal-` prefix from a role name to get the chapterx EMS bot name. */
export function portalEmsName(role: Role): string {
  const lower = role.name.toLowerCase()
  return lower.startsWith(PORTAL_ROLE_PREFIX)
    ? role.name.slice(PORTAL_ROLE_PREFIX.length)
    : role.name
}

/**
 * A portal-bot role is a non-managed role following the `portal-<name>`
 * convention. The relay's own integration-managed `Portal` umbrella role is
 * excluded (it is `managed === true` and has no `portal-` prefix).
 */
export function isPortalBotRole(role: Role): boolean {
  return !role.managed && role.name.toLowerCase().startsWith(PORTAL_ROLE_PREFIX)
}

function accountTarget(member: GuildMember): BotTarget {
  return {
    kind: 'account',
    id: member.user.id,
    pinTarget: `<@${member.user.id}>`,
    emsName: member.displayName || member.user.username,
    displayName: member.displayName,
  }
}

function portalTarget(role: Role): BotTarget {
  const ems = portalEmsName(role)
  return {
    kind: 'portal',
    // chapterx has no Discord account for a portal persona and matches it by
    // EMS/config name (not role id), so the EMS name is both the storage key
    // and the pin target.
    id: ems,
    pinTarget: ems,
    emsName: ems,
    // User-facing label: the clean EMS name (not the role name), so the
    // `portal-` plumbing prefix never leaks into command replies or public
    // /ichor sale and /sleep announcements. The autocomplete picker still shows
    // the full `portal-<name>` role (see botTargetChoices) for selectability.
    displayName: ems,
  }
}

/**
 * Resolve a `bot` option value to an account bot (guild member with
 * `user.bot`) or a portal bot (a `portal-*` guild role). Accepts the snowflake
 * id emitted by {@link botTargetChoices}, a raw user/role mention, or a typed
 * name. Returns null if nothing matches in this guild.
 */
export function resolveBotTarget(
  interaction: ChatInputCommandInteraction,
  input: string,
): BotTarget | null {
  const guild = interaction.guild
  if (!guild) return null
  const raw = input.trim()
  if (!raw) return null

  // 1. Explicit role mention <@&id>
  const roleMention = raw.match(/^<@&(\d+)>$/)
  if (roleMention) {
    const role = guild.roles.cache.get(roleMention[1]!)
    if (role) return portalTarget(role)
  }

  // 2. User mention / bare id — could be an account bot or a portal role id.
  const userMention = raw.match(/^<@!?(\d+)>$/)
  const asId = userMention ? userMention[1]! : /^\d+$/.test(raw) ? raw : null
  if (asId) {
    const member = guild.members.cache.get(asId)
    if (member?.user.bot) return accountTarget(member)
    const role = guild.roles.cache.get(asId)
    if (role && isPortalBotRole(role)) return portalTarget(role)
  }

  // 3. Name match — portal roles first (more specific), then bot members.
  const q = raw.toLowerCase()
  for (const role of guild.roles.cache.values()) {
    if (!isPortalBotRole(role)) continue
    if (role.name.toLowerCase() === q || portalEmsName(role).toLowerCase() === q) {
      return portalTarget(role)
    }
  }
  for (const member of guild.members.cache.values()) {
    if (!member.user.bot) continue
    if (
      member.displayName.toLowerCase() === q
      || (member.user.globalName ?? '').toLowerCase() === q
      || member.user.username.toLowerCase() === q
    ) {
      return accountTarget(member)
    }
  }
  return null
}

/**
 * Autocomplete choices for a `bot` option: portal-bot roles + account bot
 * members in this guild. The submitted value is always the snowflake id, so
 * {@link resolveBotTarget} resolves it unambiguously. Capped at Discord's 25.
 */
export function botTargetChoices(
  interaction: AutocompleteInteraction,
  query: string,
): Array<{ name: string; value: string }> {
  const guild = interaction.guild
  if (!guild) return []
  const q = query.trim().toLowerCase()
  const choices: Array<{ name: string; value: string }> = []

  // Portal-bot roles (🌀 prefix to distinguish from account bots in the picker).
  for (const role of guild.roles.cache.values()) {
    if (!isPortalBotRole(role)) continue
    if (q && !role.name.toLowerCase().includes(q) && !portalEmsName(role).toLowerCase().includes(q)) continue
    choices.push({ name: `🌀 ${role.name} (portal)`.slice(0, 100), value: role.id })
  }

  // Account bot members.
  for (const member of guild.members.cache.values()) {
    if (!member.user.bot) continue
    if (member.user.id === interaction.client.user?.id) continue  // don't list self
    if (q) {
      const dn = (member.displayName ?? '').toLowerCase()
      const gn = (member.user.globalName ?? '').toLowerCase()
      const un = member.user.username.toLowerCase()
      if (!dn.includes(q) && !gn.includes(q) && !un.includes(q)) continue
    }
    choices.push({ name: `${member.displayName} (@${member.user.username})`.slice(0, 100), value: member.user.id })
  }

  choices.sort((a, b) => a.name.localeCompare(b.name))
  return choices.slice(0, 25)
}
