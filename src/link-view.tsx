// The screens for adding a device (link-device.ts): showing a code, and answering one that was opened.
import {useEffect, useState} from 'preact/hooks'
import {noteAddedHere} from './devices'
import {streamOf} from './envelope'
import {admit} from './gate'
import {installed, onIos} from './install'
import type {Identity} from './identity'
import {askToJoin, awaitRequest, linkToFragment, makeLink, newDeviceTag, type DeviceLink, type Given, type LinkRole, type Request} from './link-device'
import {mailboxes} from './mailbox'
import {QrCode} from './qr'
import type {Store} from './store'

const urlOf = (link: DeviceLink) => location.origin + location.pathname + linkToFragment(link)

/** Makes this device the person who was given, and starts again as them. */
async function become(store: Store, given: Given): Promise<void> {
  if ((await store.listChats()).length > 0) throw new Error('already in use')
  await store.saveIdentity(given)
  admit()
  void navigator.storage?.persist?.()
  location.replace(location.origin + location.pathname)
}

/** The new device, waiting to be let in: the number to check, and what happens when it is. */
function Waiting(props: {link: DeviceLink; store: Store; where: string}) {
  const {link, store, where} = props
  const [check, setCheck] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    const asking = askToJoin(link, mailboxes, given =>
      void become(store, given).catch(() => setProblem('This browser already has chats of its own, so it was not changed.'))
    )
    setCheck(asking.check)
    return asking.close
  }, [link])
  if (problem) return <p class="error">{problem}</p>
  if (!check) return null
  return (
    <div class="device-check">
      <p>
        {where} will show a number. Check that it is <b class="check">{check}</b>, then tap <b>Add it</b> there.
      </p>
      <p class="note">This browser becomes you, with your chats, as soon as you do.</p>
    </div>
  )
}

/** The device that is already the person: each device that asks, to let in or not. */
function Requests(props: {link: DeviceLink; identity: Identity; onAdded: () => void}) {
  const {link, identity, onAdded} = props
  const [requests, setRequests] = useState<Request[]>([])
  const [added, setAdded] = useState(false)
  useEffect(() => awaitRequest(link, mailboxes, request => setRequests(current => [...current, request])), [link])
  if (added) return <p role="status">Added. That device now has your chats, and anything you write there comes from you.</p>
  if (requests.length === 0) return <p class="note waiting">Waiting for the other device…</p>
  return (
    <div class="device-requests">
      {requests.map(request => (
        <div class="device-request" key={request.check}>
          <p>
            A device wants to be you. It shows <b class="check">{request.check}</b>.
          </p>
          <p class="note">Only add it if that is the number on the device in front of you. It will be able to read all your chats and write as you.</p>
          <div class="row">
            <button
              type="button"
              onClick={() => {
                const device = newDeviceTag()
                noteAddedHere(streamOf({author: identity.id, device}))
                request.give({name: identity.name, signSecret: identity.signSecret, dhSecret: identity.dhSecret, device})
                setAdded(true)
                onAdded()
              }}
            >
              Add it
            </button>
            <button type="button" onClick={() => setRequests(current => current.filter(other => other !== request))}>
              Not this one
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Shows a code for adding a device. `role` says which device this is: the new one, which is let in, or
 * the one that is already the person, which lets the other in.
 */
export function DeviceCode(props: {role: LinkRole; store: Store; identity: Identity; onClose: () => void}) {
  const {role, store, identity, onClose} = props
  const [link, setLink] = useState(() => makeLink(role))
  const [copied, setCopied] = useState(false)
  const [done, setDone] = useState(false)
  // A fresh code when this one runs out.
  useEffect(() => {
    const timer = setTimeout(() => setLink(makeLink(role)), Math.max(0, link.expires - Date.now()))
    return () => clearTimeout(timer)
  }, [link])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(urlOf(link))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // The code still works.
    }
  }
  return (
    <section class="invite device-code">
      {!done && <QrCode text={urlOf(link)} label={role === 'new' ? 'Code to add this browser' : 'Code to add a device'} />}
      {!done && (
        <p class="note">
          {role === 'new'
            ? installed() && onIos()
              ? 'If you use snrdlr in Safari on this iPhone, tap Open in Safari. Otherwise, on a device that already has your snrdlr, scan this with snrdlr or the camera.'
              : 'On a device that already has your snrdlr, scan this with snrdlr or the camera, or open the link there.'
            : 'On the new device, scan this with the camera, or open the link there.'}{' '}
          It works for 10 minutes.
        </p>
      )}
      {role === 'new' ? (
        <Waiting key={linkToFragment(link)} link={link} store={store} where="Your other device" />
      ) : (
        <Requests key={linkToFragment(link)} link={link} identity={identity} onAdded={() => setDone(true)} />
      )}
      <div class="row">
        {/* On an iPhone, the Home Screen app and Safari are kept apart, but the app can open Safari. */}
        {role === 'new' && installed() && onIos() && (
          <button type="button" onClick={() => (location.href = `x-safari-${urlOf(link)}`)}>
            Open in Safari
          </button>
        )}
        {!done && (
          <button type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        )}
        <button type="button" onClick={onClose}>
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
    </section>
  )
}

/** A device code that was opened here, by scanning it or following its link. */
export function OpenedDeviceLink(props: {link: DeviceLink; store: Store; identity: Identity; onClose: () => void}) {
  const {link, store, identity, onClose} = props
  const [hasChats, setHasChats] = useState<boolean | null>(null)
  useEffect(() => void store.listChats().then(chats => setHasChats(chats.length > 0)), [])
  if (hasChats === null) return null
  const isPerson = identity.name !== '' || hasChats
  let body
  if (link.expires < Date.now()) body = <p>This code has run out. Make a new one on the device showing it.</p>
  else if (link.role === 'new' && isPerson) body = <Requests link={link} identity={identity} onAdded={() => {}} />
  else if (link.role === 'existing' && !hasChats) body = <Waiting link={link} store={store} where="The device showing the code" />
  else if (link.role === 'new')
    body = <p>This is a code for adding a browser to someone's snrdlr. Open it on a device that already has your snrdlr.</p>
  else body = <p>This browser already has chats of its own, so it can't be added. Open the link on the new device.</p>
  return (
    <main class="home">
      <h1>snrdlr</h1>
      <h2>{link.role === 'new' && isPerson ? 'Add a device' : 'Add this browser'}</h2>
      {body}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </main>
  )
}
