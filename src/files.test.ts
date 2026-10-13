import {describe, expect, it} from 'vitest'
import {fileHash, openFile, sealFile} from './files'

describe('files', () => {
  it('seals a file under a key of its own and opens it again', async () => {
    const plain = crypto.getRandomValues(new Uint8Array(5000))
    const sealed = await sealFile(plain)
    expect(sealed.key).toHaveLength(32)
    expect(sealed.hash).toBe(await fileHash(sealed.data))
    expect(sealed.data.length).toBeGreaterThan(plain.length)
    expect(await openFile(sealed.data, sealed.key)).toEqual(plain)
  })

  it('gives the same file a different key and name every time', async () => {
    const plain = new Uint8Array([1, 2, 3])
    const [first, second] = [await sealFile(plain), await sealFile(plain)]
    expect(first.hash).not.toBe(second.hash)
    expect(first.key).not.toEqual(second.key)
  })

  it('will not open a file that was altered, or with the wrong key', async () => {
    const sealed = await sealFile(new Uint8Array([1, 2, 3, 4]))
    const altered = new Uint8Array(sealed.data)
    altered[altered.length - 1] ^= 1
    await expect(openFile(altered, sealed.key)).rejects.toThrow()
    await expect(openFile(sealed.data, new Uint8Array(32))).rejects.toThrow()
    await expect(openFile(new Uint8Array(4), sealed.key)).rejects.toThrow()
  })
})
