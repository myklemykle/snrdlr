// Shows an emoji: one of the app's own birds as its drawing, any other as the text it is.
import {isBird} from './emoji'

const BIRD_URLS = new Map(
  Object.entries(import.meta.glob('./birds/*.svg', {eager: true, query: '?url', import: 'default'})).map(([path, url]) => [
    `:bird-${path.slice('./birds/'.length, -'.svg'.length)}:`,
    url as string
  ])
)

/** What an emoji is called aloud: a bird by its name ("bird, nap"), any other by itself. */
export const emojiLabel = (emoji: string) => (isBird(emoji) ? `bird, ${emoji.slice(':bird-'.length, -1).replace(/-/g, ' ')}` : emoji)

export function Emoji(props: {emoji: string; class?: string}) {
  const {emoji} = props
  const url = BIRD_URLS.get(emoji)
  if (url) return <img class={props.class ? `bird ${props.class}` : 'bird'} src={url} alt={emojiLabel(emoji)} draggable={false} />
  return props.class ? <span class={props.class}>{emoji}</span> : <>{emoji}</>
}
