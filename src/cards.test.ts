import {describe, expect, it} from 'vitest'
import {behindWhiteText, COLORS} from './cards'

const contrastWithWhite = (hex: string) => {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map(at => linear(parseInt(hex.slice(at, at + 2), 16) / 255))
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05)
}

describe('own messages in their own colour', () => {
  it('darkens each colour just enough for white words to read on it', () => {
    for (const [name, color] of COLORS) {
      const shade = behindWhiteText(color)
      expect(contrastWithWhite(shade), name).toBeGreaterThanOrEqual(4.5)
      // Not much darker than it had to be.
      expect(contrastWithWhite(shade), name).toBeLessThan(contrastWithWhite(color) >= 4.5 ? contrastWithWhite(color) + 0.01 : 5.2)
    }
  })

  it('leaves a colour that is already dark enough as it is', () => {
    expect(behindWhiteText('#1f3a80')).toBe('#1f3a80')
  })
})
