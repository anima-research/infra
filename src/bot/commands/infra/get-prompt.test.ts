import { describe, it, expect } from 'vitest'
import { formatPromptReadable } from './get-prompt.js'

describe('formatPromptReadable', () => {
  it('renders Anthropic body (separate system + messages)', () => {
    const out = formatPromptReadable(
      {
        system: 'You are a test bot.',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      },
      'claude-test',
    )
    expect(out).toContain('=== SYSTEM ===')
    expect(out).toContain('You are a test bot.')
    expect(out).toContain('hello')
    expect(out).toContain('hi there')
    expect(out).not.toContain('[no messages]')
  })

  it('renders OpenAI body (system role inside messages)', () => {
    const out = formatPromptReadable(
      {
        messages: [
          { role: 'system', content: 'sys prompt' },
          { role: 'user', content: 'q' },
        ],
      },
      'gpt-test',
    )
    expect(out).toContain('=== SYSTEM ===')
    expect(out).toContain('sys prompt')
    expect(out).toContain('q')
    expect(out).not.toContain('[no messages]')
  })

  it('renders Gemini body (contents + systemInstruction)', () => {
    const out = formatPromptReadable(
      {
        systemInstruction: { parts: [{ text: 'gem system' }] },
        contents: [
          { role: 'user', parts: [{ text: 'user turn' }] },
          { role: 'model', parts: [{ text: 'model turn' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] },
        ],
      },
      'gemini-test',
    )
    expect(out).toContain('=== SYSTEM ===')
    expect(out).toContain('gem system')
    expect(out).toContain('[user]')
    expect(out).toContain('user turn')
    // model → assistant, and inlineData is marked, not dropped
    expect(out).toContain('[assistant]')
    expect(out).toContain('model turn[image]')
    expect(out).not.toContain('[no messages]')
  })

  it('renders base/completion body (single prompt string)', () => {
    const out = formatPromptReadable(
      { prompt: 'alice: hi\nbob: hey\nalice:' },
      'base-test',
    )
    expect(out).toContain('=== CONVERSATION ===')
    expect(out).toContain('alice: hi')
    expect(out).toContain('bob: hey')
    expect(out).not.toContain('[no messages]')
  })

  it('falls back to [no messages] only for genuinely empty bodies', () => {
    const out = formatPromptReadable({}, 'unknown')
    expect(out).toContain('[no messages]')
  })
})
