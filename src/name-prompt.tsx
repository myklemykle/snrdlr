// Asking someone for their name where they already are. Nobody is stopped at the door for it: a
// newcomer is "New Friend" (identity.ts) until they give one here, in a chat or on the front page.
import {useState} from 'preact/hooks'
import {cleanName, loadIdentity, MAX_NAME_LENGTH, namePending, setNamePending, type Identity} from './identity'
import type {Store} from './store'

export function NamePrompt(props: {
  store: Store
  identity: Identity
  onIdentity: (identity: Identity) => void
  /** After the name is saved: to send it where the person is. */
  onSaved?: (name: string) => void
}) {
  const {store, identity, onIdentity, onSaved} = props
  const [asking, setAsking] = useState(namePending)
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  if (!asking) return null

  const save = async (event: Event) => {
    event.preventDefault()
    const called = cleanName(name)
    if (!called) return
    // The device's tag stays: without it this device would number its messages like the person's first.
    const secrets = {name: called, signSecret: identity.signSecret, dhSecret: identity.dhSecret, ...(identity.device ? {device: identity.device} : {})}
    try {
      await store.saveIdentity(secrets)
    } catch {
      return setProblem("Your name couldn't be saved. Try again.")
    }
    setNamePending(false)
    setAsking(false)
    onIdentity(loadIdentity(secrets))
    onSaved?.(called)
  }
  const later = () => {
    setNamePending(false)
    setAsking(false)
  }
  return (
    <form class="name-prompt" onSubmit={save}>
      <p>{`You're “${identity.name}” here for now. What should people call you?`}</p>
      <div class="actions">
        <input
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Your name"
          maxLength={MAX_NAME_LENGTH}
          aria-label="Your name"
          // So a phone can offer the first name from its owner's contact card.
          name="given-name"
          autocomplete="given-name"
          autocapitalize="words"
        />
        <button type="submit" disabled={!cleanName(name)}>
          Save name
        </button>
        <button type="button" onClick={later}>
          Later
        </button>
      </div>
      {problem && <p class="error">{problem}</p>}
      <p class="note">Your name and keys stay on this device. There is no account, so they can't be recovered if you clear this site's data.</p>
    </form>
  )
}
