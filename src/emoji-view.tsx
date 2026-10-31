// Shows an emoji: one of the snerds as its drawing, any other as the text it is.
import {snerdName} from './emoji'

const SNERD_URLS = new Map(
  Object.entries(import.meta.glob('./snerds/*.svg', {eager: true, query: '?url', import: 'default'})).map(([path, url]) => [
    path.slice('./snerds/'.length, -'.svg'.length),
    url as string
  ])
)

/** What an emoji is called aloud: a snerd by its name ("snerd, nap"), any other by itself. */
export function emojiLabel(emoji: string) {
  const name = snerdName(emoji)
  return name ? `snerd, ${name.replace(/-/g, ' ')}` : emoji
}

export function Emoji(props: {emoji: string; class?: string}) {
  const {emoji} = props
  const url = SNERD_URLS.get(snerdName(emoji) ?? '')
  if (url) return <img class={props.class ? `snerd ${props.class}` : 'snerd'} src={url} alt={emojiLabel(emoji)} draggable={false} />
  return props.class ? <span class={props.class}>{emoji}</span> : <>{emoji}</>
}
