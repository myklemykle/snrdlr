// Gets a chosen picture ready to send: shrinks it, re-encodes it, and seals it. Redrawing the picture
// is also what removes the location and camera details that phones embed in photos.
import {IMAGE_MIME, MAX_PREVIEW_BYTES, type ImageContent} from './envelope'
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
export async function prepareImage(chosen: Blob, caption?: string): Promise<PreparedImage> {
  const url = URL.createObjectURL(chosen)
  try {
    const source = new Image()
    source.src = url
    // Decoding through an image element turns the picture the right way up, as the camera recorded it.
    await source.decode()
    if (!source.naturalWidth || !source.naturalHeight) throw new Error('empty picture')

    const canvas = draw(source, MAX_SIDE)
    let shown = await encode(canvas, QUALITIES[0])
    for (const quality of QUALITIES.slice(1)) {
      if (shown.size <= TARGET_BYTES) break
      shown = await encode(canvas, quality)
    }
    const preview = new Uint8Array(await (await encode(draw(source, PREVIEW_SIDE), 0.5)).arrayBuffer())
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
        preview: preview.length <= MAX_PREVIEW_BYTES ? preview : new Uint8Array(0),
        ...(caption ? {caption} : {})
      },
      file: sealed.data,
      shown
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Opens a stored picture for display. */
export async function openImage(file: Uint8Array, image: ImageContent): Promise<Blob> {
  return new Blob([new Uint8Array(await openFile(file, image.key))], {type: IMAGE_MIME})
}
