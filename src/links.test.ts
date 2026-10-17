import {describe, expect, it} from 'vitest'
import {findLinks, pictureLink} from './links'

const links = (text: string) => findLinks(text).filter(piece => piece.href).map(piece => [piece.text, piece.href])

describe('links in messages', () => {
  it('finds web addresses, and leaves the rest as it is', () => {
    expect(findLinks('see https://example.com/a?b=1 now')).toEqual([
      {text: 'see '},
      {text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1'},
      {text: ' now'}
    ])
    expect(links('www.snrdlr.net')).toEqual([['www.snrdlr.net', 'https://www.snrdlr.net/']])
    expect(findLinks('no links here')).toEqual([{text: 'no links here'}])
  })

  it('leaves off the punctuation that ends a sentence, but keeps brackets an address uses', () => {
    expect(links('Look: https://example.com/page.')).toEqual([['https://example.com/page', 'https://example.com/page']])
    expect(links('(see https://example.com/x)')).toEqual([['https://example.com/x', 'https://example.com/x']])
    expect(links('https://en.wikipedia.org/wiki/Tea_(meal), yum')).toEqual([['https://en.wikipedia.org/wiki/Tea_(meal)', 'https://en.wikipedia.org/wiki/Tea_(meal)']])
  })

  it('makes nothing but web addresses into links', () => {
    expect(links('javascript:alert(1) data:text/html,hi file:///etc/passwd ftp://x.org')).toEqual([])
    expect(links('http://localhost:5173')).toEqual([])
    expect(links('https:// broken')).toEqual([])
  })

  it('finds the first link that points straight at a picture', () => {
    expect(pictureLink('look https://example.com/page and https://media.example.com/cat.GIF and https://x.org/b.png')).toBe('https://media.example.com/cat.GIF')
    expect(pictureLink('https://example.com/pic.jpg?size=large')).toBe('https://example.com/pic.jpg?size=large')
    expect(pictureLink('https://example.com/gallery')).toBeNull()
    expect(pictureLink('no links')).toBeNull()
  })
})
