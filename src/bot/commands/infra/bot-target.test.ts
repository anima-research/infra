import { describe, it, expect } from 'vitest'
import {
  resolveBotTarget,
  botTargetChoices,
  isPortalBotRole,
  portalEmsName,
} from './bot-target.js'

// --- Minimal discord.js fakes (ids are numeric snowflake-like strings) -------

interface FakeRole { id: string; name: string; managed: boolean }
interface FakeMember {
  user: { id: string; bot: boolean; username: string; globalName: string | null }
  displayName: string
}

const roles: FakeRole[] = [
  { id: '9000', name: 'Portal', managed: true },          // relay umbrella (managed)
  { id: '9001', name: 'portal-glm52', managed: false },   // portal bot
  { id: '9002', name: 'portal-k27code', managed: false }, // portal bot
  { id: '9003', name: 'Moderator', managed: false },      // unrelated
]

const members: FakeMember[] = [
  { user: { id: '1001', bot: true, username: 'haiku45', globalName: 'Haiku' }, displayName: 'Haiku 4.5' },
  { user: { id: '1002', bot: false, username: 'alice', globalName: 'Alice' }, displayName: 'Alice' },
  { user: { id: '1000', bot: true, username: 'infra2', globalName: 'Infra' }, displayName: 'Infra' }, // self
]

function makeGuild() {
  return {
    roles: { cache: new Map(roles.map(r => [r.id, r])) },
    members: { cache: new Map(members.map(m => [m.user.id, m])) },
  }
}

const chatIx = () => ({ guild: makeGuild() }) as any
const autoIx = (selfId = '1000') => ({ guild: makeGuild(), client: { user: { id: selfId } } }) as any

describe('isPortalBotRole / portalEmsName', () => {
  it('treats non-managed portal-<name> roles as portal bots', () => {
    expect(isPortalBotRole(roles[1] as any)).toBe(true)
    expect(isPortalBotRole(roles[0] as any)).toBe(false) // managed umbrella excluded
    expect(isPortalBotRole(roles[3] as any)).toBe(false) // unrelated role
  })
  it('derives the ems name by stripping the portal- prefix', () => {
    expect(portalEmsName(roles[1] as any)).toBe('glm52')
    expect(portalEmsName(roles[3] as any)).toBe('Moderator') // no prefix → unchanged
  })
})

describe('resolveBotTarget', () => {
  it('resolves an account bot by user id (mention pin target)', () => {
    const t = resolveBotTarget(chatIx(), '1001')!
    expect(t.kind).toBe('account')
    expect(t.id).toBe('1001')
    expect(t.pinTarget).toBe('<@1001>')
    expect(t.displayName).toBe('Haiku 4.5')
  })
  it('resolves a portal bot by role id to its EMS name (bare-name pin target)', () => {
    const t = resolveBotTarget(chatIx(), '9001')!
    expect(t.kind).toBe('portal')
    expect(t.id).toBe('glm52')
    expect(t.pinTarget).toBe('glm52')
    expect(t.emsName).toBe('glm52')
  })
  it('resolves a portal bot by explicit role mention', () => {
    const t = resolveBotTarget(chatIx(), '<@&9002>')!
    expect(t.emsName).toBe('k27code')
    expect(t.id).toBe('k27code')
  })
  it('resolves an account bot by username / display name', () => {
    expect(resolveBotTarget(chatIx(), 'haiku45')!.id).toBe('1001')
    expect(resolveBotTarget(chatIx(), 'Haiku 4.5')!.id).toBe('1001')
  })
  it('resolves a portal bot by ems name or role name', () => {
    expect(resolveBotTarget(chatIx(), 'glm52')!.id).toBe('glm52')
    expect(resolveBotTarget(chatIx(), 'portal-glm52')!.id).toBe('glm52')
  })
  it('returns null for a non-bot human or unknown input', () => {
    expect(resolveBotTarget(chatIx(), 'alice')).toBeNull()
    expect(resolveBotTarget(chatIx(), 'nope')).toBeNull()
    expect(resolveBotTarget(chatIx(), '')).toBeNull()
  })
})

describe('botTargetChoices', () => {
  it('lists portal roles + account bots; excludes umbrella, humans, and self', () => {
    const values = botTargetChoices(autoIx(), '').map(c => c.value)
    expect(values).toContain('9001') // portal-glm52
    expect(values).toContain('9002') // portal-k27code
    expect(values).toContain('1001') // haiku account bot
    expect(values).not.toContain('9000') // managed umbrella
    expect(values).not.toContain('1002') // human
    expect(values).not.toContain('1000') // self
  })
  it('filters by query across role and member names', () => {
    expect(botTargetChoices(autoIx(), 'glm').map(c => c.value)).toEqual(['9001'])
    expect(botTargetChoices(autoIx(), 'haiku').map(c => c.value)).toEqual(['1001'])
  })
})
