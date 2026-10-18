// The Invites sheet (developer mode): invites for people far away, which last as long as asked and can
// be cancelled sooner (remote-invite.ts).
import {useEffect, useState} from 'preact/hooks'
import type {Identity} from './identity'
import {mailboxes} from './mailbox'
import {
  addInvite,
  closeInvite,
  forgetRemoteInvite,
  isOpen,
  loadInvites,
  makeRemoteInvite,
  MAX_LIFETIME_MS,
  MIN_LIFETIME_MS,
  onInvitesChanged,
  remoteFragment,
  type RemoteInvite
} from './remote-invite'
import {Sheet} from './sheet'
import type {ChatRecord} from './store'

const UNITS = {minutes: 60_000, hours: 60 * 60_000, days: 24 * 60 * 60_000} as const
type Unit = keyof typeof UNITS

/** How long until then, roughly: "3 days", "5 h 20 min", "under a minute". */
function timeLeft(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`
}

const linkTo = (invite: RemoteInvite) => location.origin + location.pathname + remoteFragment(invite)

export function InvitesSheet(props: {identity: Identity; chats: ChatRecord[]; onClose: () => void}) {
  const {identity, chats, onClose} = props
  const groups = chats.filter(chat => chat.kind === 'group')
  const [invites, setInvites] = useState(loadInvites)
  useEffect(() => onInvitesChanged(() => setInvites(loadInvites())), [])
  // Shown by the clock: drawn again now and then, so the time left stays right.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 15_000)
    return () => clearInterval(timer)
  }, [])
  const now = Date.now()

  const [target, setTarget] = useState('')
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState<Unit>('days')
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const asked = Number(amount) * UNITS[unit]
  const lifetime = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, asked)) : null

  const copy = async (invite: RemoteInvite) => {
    try {
      await navigator.clipboard.writeText(linkTo(invite))
      setCopied(invite.seed)
      setTimeout(() => setCopied(current => (current === invite.seed ? null : current)), 2000)
    } catch {
      setError("The link couldn't be copied. Try again.")
    }
  }

  const make = async (event: Event) => {
    event.preventDefault()
    if (lifetime === null) return
    setMaking(true)
    setError(null)
    const group = groups.find(chat => chat.id === target) ?? null
    const invite = await makeRemoteInvite(mailboxes, identity, group, lifetime, Date.now()).catch(() => null)
    setMaking(false)
    if (!invite) return setError("The relay couldn't be reached, so no invite was made. Try again.")
    addInvite(invite)
    await copy(invite)
  }

  const cancel = async (invite: RemoteInvite) => {
    setCancelling(invite.seed)
    setError(null)
    const forgotten = await forgetRemoteInvite(mailboxes, invite)
    setCancelling(null)
    if (!forgotten) return setError("The relay couldn't be reached, so that link still works. Try cancelling again.")
    closeInvite(invite.seed)
  }

  const open = invites.filter(invite => isOpen(invite, now)).sort((a, b) => a.expiresAt - b.expiresAt)
  return (
    <Sheet label="Invites" title="Invites" class="invites" onClose={onClose}>
      <p class="note">
        For people far away; nobody needs to be online when they open the link. A group link lets in everyone who opens it until it ends or you
        cancel it, and they can read the whole group. A direct-chat link works once. Cancelling stops new people; it doesn't remove anyone.
      </p>

      <section>
        <h3>New invite</h3>
        <form class="new-invite" onSubmit={make}>
          <label>
            For{' '}
            <select value={target} onChange={event => setTarget(event.currentTarget.value)} aria-label="Invite to">
              <option value="">A direct chat with me</option>
              {groups.map(chat => (
                <option key={chat.id} value={chat.id}>
                  {chat.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lasts{' '}
            <input
              type="number"
              min="1"
              inputMode="numeric"
              value={amount}
              onInput={event => setAmount(event.currentTarget.value)}
              aria-label="How long it lasts"
            />{' '}
            <select value={unit} onChange={event => setUnit(event.currentTarget.value as Unit)} aria-label="Unit">
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </label>
          {lifetime !== null && lifetime !== asked && <p class="note">Invites last from 1 minute to 7 days, so this one lasts {timeLeft(lifetime)}.</p>}
          <button type="submit" disabled={making || lifetime === null}>
            {making ? 'Making…' : 'Make and copy link'}
          </button>
        </form>
      </section>

      {error && <p class="error">{error}</p>}

      <section>
        <h3>Open invites</h3>
        {open.length === 0 ? (
          <p class="note">None right now.</p>
        ) : (
          <ul class="open-invites" aria-label="Open invites">
            {open.map(invite => (
              <li key={invite.seed}>
                <p>
                  <b>{invite.name}</b>
                  <br />
                  <span class="note">
                    {invite.kind === 'dm' ? 'Works once' : 'Group'} · ends in {timeLeft(invite.expiresAt - now)},{' '}
                    {new Date(invite.expiresAt).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'})}
                  </span>
                </p>
                <button type="button" onClick={() => copy(invite)}>
                  {copied === invite.seed ? 'Copied' : 'Copy link'}
                </button>{' '}
                <button type="button" class="danger" disabled={cancelling === invite.seed} onClick={() => cancel(invite)}>
                  {cancelling === invite.seed ? 'Cancelling…' : 'Cancel'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <button type="button" onClick={onClose}>
        Done
      </button>
    </Sheet>
  )
}
