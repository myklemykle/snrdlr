import {describe, expect, it} from 'vitest'
import {onlyPictures} from './image'

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0))

/** A small GIF, block by block, with a comment and an editor's metadata in it. */
function gif() {
  return new Uint8Array([
    ...ascii('GIF89a'),
    2, 0, 2, 0, 0x80, 0, 0, // 2×2, a global table of 2 colours
    0, 0, 0, 255, 255, 255,
    0x21, 0xfe, 3, ...ascii('abc'), 0, // a comment
    0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0, // looping
    0x21, 0xff, 11, ...ascii('XMP DataXMP'), 2, ...ascii('hi'), 0, // an editor's metadata
    0x21, 0xf9, 4, 0, 10, 0, 0, 0, // timing
    0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0, // a picture
    0x3b
  ])
}

describe('animated GIFs', () => {
  it('keep their pictures, timing and looping, and lose comments and metadata', () => {
    const kept = onlyPictures(gif())!
    const text = String.fromCharCode(...kept)
    expect(text).toContain('NETSCAPE2.0')
    expect(text).not.toContain('abc')
    expect(text).not.toContain('XMP')
    expect(kept.at(-1)).toBe(0x3b)
    expect(kept.length).toBe(gif().length - (3 + 3 + 1) - (3 + 11 + 3 + 1))
  })

  it('are refused when they are not GIFs this can follow', () => {
    expect(onlyPictures(new Uint8Array(ascii('PNG not a gif')))).toBeNull()
    expect(onlyPictures(gif().subarray(0, 40))).toBeNull()
  })
})
