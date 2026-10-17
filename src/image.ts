// Gets a chosen picture ready to send: shrinks it, re-encodes it, and seals it. Redrawing the picture
// is also what removes the location and camera details that phones embed in photos. An animated GIF
// would stop moving if redrawn, so one small enough is sent as it is, with everything but its pictures
// and its looping taken out.
import {GIF_MIME, IMAGE_MIME, MAX_AVATAR_BYTES, MAX_PREVIEW_BYTES, type ImageContent, type PictureRef} from './envelope'
import {MAX_FILE_BYTES, openFile, sealFile} from './files'

/** The longest side of a sent picture, in pixels. Sharp on any screen; not print quality. */
export const MAX_SIDE = 1600
const PREVIEW_SIDE = 24
// Tried in turn until the result is small enough.
const QUALITIES = [0.82, 0.7, 0.55, 0.4]
const TARGET_BYTES = 600 * 1024

export type PreparedImage = {
  image: ImageContent
  /** The encrypted file. */
  file: Uint8Array
  /** The shrunken picture, for showing before it is sent. */
  shown: Blob
}

function draw(source: HTMLImageElement, longestSide: number): HTMLCanvasElement {
  const scale = Math.min(1, longestSide / Math.max(source.naturalWidth, source.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(source.naturalHeight * scale))
  const context = canvas.getContext('2d')!
  // JPEG has no transparency; without this, see-through areas would come out black.
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

const encode = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('could not encode'))), IMAGE_MIME, quality))

/** Throws if the file is not a picture this browser can read. */
export async function prepareImage(chosen: Blob, caption?: string, longestSide = MAX_SIDE): Promise<PreparedImage> {
  const url = URL.createObjectURL(chosen)
  try {
    const source = new Image()
    source.src = url
    // Decoding through an image element turns the picture the right way up, as the camera recorded it.
    await source.decode()
    if (!source.naturalWidth || !source.naturalHeight) throw new Error('empty picture')

    const preview = new Uint8Array(await (await encode(draw(source, PREVIEW_SIDE), 0.5)).arrayBuffer())
    const previewOrNone = preview.length <= MAX_PREVIEW_BYTES ? preview : new Uint8Array(0)
    if (chosen.type === GIF_MIME && longestSide === MAX_SIDE) {
      const gif = onlyPictures(new Uint8Array(await chosen.arrayBuffer()))
      const sealed = gif && (await sealFile(gif))
      if (gif && sealed && sealed.data.length <= MAX_FILE_BYTES) {
        return {
          image: {
            type: 'image',
            mime: GIF_MIME,
            hash: sealed.hash,
            key: sealed.key,
            size: sealed.data.length,
            width: source.naturalWidth,
            height: source.naturalHeight,
            preview: previewOrNone,
            ...(caption ? {caption} : {})
          },
          file: sealed.data,
          shown: new Blob([new Uint8Array(gif)], {type: GIF_MIME})
        }
      }
      // Too big to send as it is, or not a GIF this can read: it goes as a still picture.
    }

    const canvas = draw(source, longestSide)
    let shown = await encode(canvas, QUALITIES[0])
    for (const quality of QUALITIES.slice(1)) {
      if (shown.size <= TARGET_BYTES) break
      shown = await encode(canvas, quality)
    }
    const sealed = await sealFile(new Uint8Array(await shown.arrayBuffer()))
    if (sealed.data.length > MAX_FILE_BYTES) throw new Error('picture too large')
    return {
      image: {
        type: 'image',
        hash: sealed.hash,
        key: sealed.key,
        size: sealed.data.length,
        width: canvas.width,
        height: canvas.height,
        preview: previewOrNone,
        ...(caption ? {caption} : {})
      },
      file: sealed.data,
      shown
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

const AVATAR_SIDE = 96

/** A tiny square JPEG cut from the middle of a picture, small enough to travel inside a message. */
export async function prepareAvatar(chosen: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(chosen)
  try {
    const source = new Image()
    source.src = url
    await source.decode()
    const side = Math.min(source.naturalWidth, source.naturalHeight)
    if (!side) throw new Error('empty picture')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = AVATAR_SIDE
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, AVATAR_SIDE, AVATAR_SIDE)
    context.drawImage(source, (source.naturalWidth - side) / 2, (source.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE)
    for (const quality of [0.8, 0.6, 0.4]) {
      const bytes = new Uint8Array(await (await encode(canvas, quality)).arrayBuffer())
      if (bytes.length <= MAX_AVATAR_BYTES) return bytes
    }
    throw new Error('picture too detailed')
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Opens a stored picture for display. */
export async function openImage(file: Uint8Array, image: Pick<PictureRef, 'key'> & {mime?: string}): Promise<Blob> {
  return new Blob([new Uint8Array(await openFile(file, image.key))], {type: image.mime ?? IMAGE_MIME})
}

/**
 * A GIF with only its pictures and how they loop: comments and the blocks that editing programs add
 * (which can carry details of who made it, and where) are left out. Null if it is not a GIF this can
 * follow, in which case it is sent as a still picture instead.
 */
export function onlyPictures(gif: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const out: number[] = []
  let at = 0
  const take = (count: number) => {
    if (at + count > gif.length) throw new Error('short')
    for (let i = 0; i < count; i++) out.push(gif[at + i])
    at += count
  }
  const skipBlocks = () => {
    for (;;) {
      const size = gif[at++]
      if (size === undefined) throw new Error('short')
      if (size === 0) return
      at += size
    }
  }
  const takeBlocks = () => {
    for (;;) {
      const size = gif[at]
      if (size === undefined) throw new Error('short')
      take(1 + size)
      if (size === 0) return
    }
  }
  try {
    const header = String.fromCharCode(...gif.subarray(0, 6))
    if (header !== 'GIF87a' && header !== 'GIF89a') return null
    take(6 + 7)
    const flags = gif[10]
    if (flags & 0x80) take(3 * 2 ** ((flags & 7) + 1))
    for (;;) {
      const kind = gif[at]
      if (kind === 0x3b) {
        take(1)
        return new Uint8Array(out)
      }
      if (kind === 0x2c) {
        // A picture: its place, its own colours if any, then its compressed pixels.
        take(10)
        const own = gif[at - 1]
        if (own & 0x80) take(3 * 2 ** ((own & 7) + 1))
        take(1)
        takeBlocks()
      } else if (kind === 0x21) {
        const label = gif[at + 1]
        const app = String.fromCharCode(...gif.subarray(at + 3, at + 14))
        // Timing between pictures (0xf9), and the looping that browsers read from a NETSCAPE block, stay.
        if (label === 0xf9 || (label === 0xff && (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0'))) {
          take(2)
          takeBlocks()
        } else {
          at += 2
          skipBlocks()
        }
      } else return null
    }
  } catch {
    return null
  }
}
