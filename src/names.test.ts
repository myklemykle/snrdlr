import {describe, expect, it} from 'vitest'
import {uniqueChatName} from './names'

describe('uniqueChatName', () => {
  it('keeps a name nobody is using', () => {
    expect(uniqueChatName('Chat', [])).toBe('Chat')
    expect(uniqueChatName('Cabin', ['Chat', 'Chat 2'])).toBe('Cabin')
  })

  it('numbers a name that is taken, skipping numbers already used', () => {
    expect(uniqueChatName('Chat', ['Chat'])).toBe('Chat 2')
    expect(uniqueChatName('Chat', ['Chat', 'Chat 2', 'Chat 3'])).toBe('Chat 4')
    expect(uniqueChatName('Chat', ['Chat', 'Chat 3'])).toBe('Chat 2')
  })

  it('treats names that differ only in case as the same', () => {
    expect(uniqueChatName('cabin', ['Cabin'])).toBe('cabin 2')
  })
})
