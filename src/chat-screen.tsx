import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'preact/hooks'
import {claimChat, heardNews, unclaimChat} from './background'
import {latestCards} from './cards'
import {admit, authFor, chatFromGroupInvite, groupFromDirect} from './chats'
import {latestEdits} from './edits'
import {emojiSize, splitEmoji} from './emoji'
import {EmojiPicker} from './emoji-picker'
import {IMAGE_MIME, MAX_TEXT_LENGTH, type ImageContent, type MessageRef} from './envelope'
import {cleanName, MAX_NAME_LENGTH, memberId, type Identity} from './identity'
import {prepareImage, type PreparedImage} from './image'
import {ImageView, ImageViewer, useImageUrl} from './image-view'
import {createInvite, inviteToFragment, type Invite} from './invite'
import {mailboxes} from './mailbox'
import {hostInvite} from './invite-room'
import {openCert} from './membership'
import {cardFor, hasPart, loadProfile, PARTS, setShownIn, showsIn, type Part} from './profile'
import {Avatar, ProfileCard} from './profile-view'
import {QrCode} from './qr'
import {messageKey, QUICK_REACTIONS, tallyReactions} from './reactions'
import {describeRoutes, type Route} from './route'
import {uniqueChatName} from './names'
import {openSession, type ConnectionStatus, type Session} from './session'
import {playSound} from './sound'
import {devMode, makeStandingInvite} from './standing-invite'
import type {ChatRecord, MessageRecord, Store} from './store'
import {dayKey, formatDay, formatTime} from './time'
import {joinChat} from './transport'
import {fetchTurnServers} from './turn'
import {useUpdateHold} from './update'

const ROUTE_POLL_MS = 3000
// A forgotten invite screen should not stay open indefinitely.
const INVITE_LIFETIME_MS = 10 * 60 * 1000

const BUSY_LABELS: Record<Exclude<ConnectionStatus, 'idle'>, string> = {
  connecting: 'Connecting…',
  searching: 'Looking for others…',
  checking: 'Checking connection…',
  reconnecting: 'Reconnecting…'
}

// How long a finger must rest on a message to open its menu, and how far it may drift meanwhile.
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP_PX = 10
const MAX_ATTACHED = 10

/** A small picture beside the words where a picture message is quoted. */
function QuoteThumb(props: {store: Store; chatId: string; image: ImageContent; held: boolean}) {
  const {store, chatId, image, held} = props
  const url = useImageUrl(store, chatId, image, held)
  // Until the picture itself is on this device, its tiny preview stands in.
  const preview = useMemo(
    () => (image.preview.length > 0 ? URL.createObjectURL(new Blob([new Uint8Array(image.preview)], {type: IMAGE_MIME})) : null),
    [image.hash]
  )
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])
  return <span class="thumb">{(url ?? preview) && <img class={url ? '' : 'blur'} src={url ?? preview!} alt="" draggable={false} />}</span>
}

export function ChatScreen(props: {
  chat: ChatRecord
  identity: Identity
  store: Store
  /** Start with the invite code showing, as when the chat was just created. */
  inviteOnOpen: boolean
  onBack: () => void
  /** Go to another chat, optionally with its invite code showing. */
  onOpenChat: (id: string, showInvite: boolean) => void
}) {
  const {chat, identity, store, inviteOnOpen, onBack, onOpenChat} = props
  const direct = chat.kind === 'dm'
  const [chatName, setChatName] = useState(chat.name)
  const [messages, setMessages] = useState<MessageRecord[] | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [routes, setRoutes] = useState<Route[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<Invite | null>(() => (inviteOnOpen && !direct ? createInvite(identity) : null))
  const [inviteNote, setInviteNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const session = useRef<Session | null>(null)
  const heard = useRef<((messages: MessageRecord[]) => boolean) | null>(null)
  // Which pictures' files are on this device.
  const [files, setFiles] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    let opened: Session | null = null
    heard.current = null
    void (async () => {
      // Take the chat over from any background sync before joining its room ourselves.
      await claimChat(chat.id)
      if (cancelled) return
      opened = await openSession({
        chat,
        identity,
        store,
        card: await cardFor(chat.id, store),
        mailbox: mailboxes,
        // Fetched on every (re)connect, so long-open chats never reuse expired TURN credentials.
        connect: async (keys, handlers) => joinChat(keys, handlers, await fetchTurnServers(), authFor(chat, identity)),
        handlers: {
          onMessages: next => {
            if (cancelled) return
            // A sound for what other people say as they say it, but not for the history that loads when
            // the chat opens or is caught up on.
            if (heard.current === null) heard.current = heardNews(identity.id, next)
            else if (heard.current(next)) playSound()
            setMessages(next)
          },
          onChatName: next => !cancelled && setChatName(next),
          onStatus: next => !cancelled && setStatus(next),
          onPeersChange: peerIds => {
            if (cancelled) return
            setPeers(peerIds)
            if (peerIds.length > 0) setError(null)
          },
          onError: message => !cancelled && setError(message),
          onFiles: held => !cancelled && setFiles(held)
        }
      })
      if (cancelled) void opened.close()
      else session.current = opened
    })().catch(() => !cancelled && setError("This chat couldn't be opened."))
    return () => {
      cancelled = true
      session.current = null
      void Promise.resolve(opened?.close()).finally(() => unclaimChat(chat.id))
    }
  }, [chat.id])

  // Everything on screen counts as read, including what arrives while the chat is open.
  useEffect(() => {
    if (messages) void store.markRead(chat.id, Date.now())
  }, [messages])

  // Shows the chat's name in tabs and browser history.
  useEffect(() => {
    const before = document.title
    document.title = `${chatName} · snrdlr`
    return () => {
      document.title = before
    }
  }, [chatName])

  // Phones drop connections when the app is in the background, so check on them when it comes back.
  useEffect(() => {
    let hiddenAt: number | null = document.hidden ? Date.now() : null
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now()
      else {
        void session.current?.resume(hiddenAt === null ? 0 : Date.now() - hiddenAt)
        hiddenAt = null
      }
    }
    const onPageShow = (event: PageTransitionEvent) => event.persisted && void session.current?.resume(Infinity)
    const onOnline = () => void session.current?.resume(Infinity)
    document.addEventListener('visibilitychange', onVisibility)
    addEventListener('pageshow', onPageShow)
    addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('pageshow', onPageShow)
      removeEventListener('online', onOnline)
    }
  }, [])

  // While an invite is showing, wait in its room and let in everyone who arrives. Closing it forgets
  // the token, so the code stops working.
  useEffect(() => {
    if (!invite) return
    let cancelled = false
    let host: {close: () => void} | null = null
    void fetchTurnServers().then(turnServers => {
      if (cancelled) return
      host = hostInvite(
        invite,
        request => {
          // Admits whoever asks while the code is showing, and records it in the chat for the others.
          const {sealedGrant, cert} = admit(chat, identity, invite, request, Date.now())
          void session.current?.postCert(cert).catch(() => {})
          return sealedGrant
        },
        turnServers
      )
    })
    const timer = setTimeout(() => {
      setInvite(null)
      setInviteNote('The invite closed after 10 minutes.')
    }, INVITE_LIFETIME_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      host?.close()
    }
  }, [invite])

  // Polled, because the route can change mid-connection and browsers fire no event for it.
  useEffect(() => {
    if (peers.length === 0) return setRoutes([])
    let cancelled = false
    const refresh = () => void session.current?.routes().then(found => !cancelled && setRoutes(found))
    refresh()
    const timer = setInterval(refresh, ROUTE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [peers])


  // A member can post their profile more than once; only the first is shown as joining.
  const firstProfiles = useMemo(() => {
    const seen = new Set<string>()
    const first = new Set<MessageRecord>()
    for (const message of messages ?? []) {
      if (message.content.type !== 'profile' || seen.has(message.author)) continue
      seen.add(message.author)
      first.add(message)
    }
    return first
  }, [messages])
  // The messages that get a line of their own. Certificates show through the "joined" lines, reactions
  // on the message they are about, and unknown kinds wait for a newer version of the app.
  const shown = useMemo(
    () =>
      (messages ?? []).filter(message => {
        const {type} = message.content
        if (type === 'profile') return message.author !== identity.id && firstProfiles.has(message)
        return type === 'text' || type === 'image' || type === 'group-invite' || type === 'rename'
      }),
    [messages]
  )
  const reactions = useMemo(() => tallyReactions(messages ?? []), [messages])
  const edits = useMemo(() => latestEdits(messages ?? []), [messages])
  // What each person shows of their profile in this chat, and whose profile is open.
  const cards = useMemo(() => latestCards(messages ?? []), [messages])
  const [profileOf, setProfileOf] = useState<string | null>(null)
  const [ownProfile, setOwnProfile] = useState(loadProfile)
  const showOwnProfile = async (part: Part, shown: boolean) => {
    setOwnProfile(setShownIn(chat.id, part, shown))
    await session.current?.shareCard(await cardFor(chat.id, store)).catch(() => setError('Your profile could not be sent.'))
  }
  const peerId = chat.peer ? memberId(chat.peer.signPublic) : null
  /** What a message says now: its words or its caption, as last edited. */
  const wordsOf = (message: MessageRecord) => {
    const {content} = message
    return edits.get(messageKey(message)) ?? (content.type === 'text' ? content.text : content.type === 'image' ? (content.caption ?? '') : '')
  }

  // When the on-screen keyboard opens or changes height the log gets shorter. If the newest message was
  // in view, keep it in view; otherwise the keyboard would push it out of sight.
  const log = useRef<HTMLOListElement>(null)
  const atEnd = useRef(true)
  const noteScroll = () => {
    const element = log.current
    if (element) atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }
  // A new line in the log scrolls to the end. A reaction changes no line, so it only does so if the end
  // was already in view; reacting to an old message must not jump away from it.
  // Only ever the log itself is scrolled. Asking the browser to bring a line into view can also slide
  // the whole page, which on an iPhone puts the message box under the keyboard.
  const toEnd = () => {
    const element = log.current
    if (element) element.scrollTop = element.scrollHeight
  }
  const lineCount = useRef(-1)
  useEffect(() => {
    if (shown.length !== lineCount.current || atEnd.current) toEnd()
    lineCount.current = shown.length
  }, [messages])
  // An iPhone's keyboard covers the bottom of the page instead of making the page shorter, and Safari
  // then slides the page up to show where the typing is. So the chat is made as tall as what is
  // actually visible and the page is held at the top: the message box sits just above the keyboard,
  // and the chat's name stays on screen.
  const screen = useRef<HTMLElement>(null)
  useEffect(() => {
    const viewport = window.visualViewport
    const fit = () => {
      // Zoomed in, the visible part is small because of the zoom, and must be free to move about.
      if (viewport && viewport.scale <= 1.01) {
        screen.current?.style.setProperty('--visible-height', `${viewport.height}px`)
        if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0)
      }
      if (atEnd.current) toEnd()
    }
    fit()
    window.addEventListener('resize', fit)
    viewport?.addEventListener('resize', fit)
    viewport?.addEventListener('scroll', fit)
    return () => {
      window.removeEventListener('resize', fit)
      viewport?.removeEventListener('resize', fit)
      viewport?.removeEventListener('scroll', fit)
    }
  }, [])

  // Each member's most recent profile message gives their display name.
  const names = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of messages ?? []) {
      if (message.content.type === 'profile') found.set(message.author, message.content.name)
    }
    return found
  }, [messages])
  const nameOf = (author: string) => (author === identity.id ? 'you' : (names.get(author) ?? `Member ${author.slice(0, 6)}`))

  // Who admitted whom, from the certificates members have posted. Only genuine ones count.
  const invitedBy = useMemo(() => {
    const found = new Map<string, string>()
    for (const message of messages ?? []) {
      const {content} = message
      const certs = content.type === 'member-cert' ? [content.cert] : content.type === 'profile' ? (content.chain ?? []) : []
      for (const bytes of certs) {
        try {
          const cert = openCert(chat.id, bytes)
          found.set(memberId(cert.subject), memberId(cert.issuer))
        } catch {
          // Not a valid certificate for this chat; ignore it.
        }
      }
    }
    return found
  }, [messages])
  const founderId = chat.kind === 'group' ? memberId(chat.context) : null
  // Someone who came in by a standing link was admitted by a throwaway member, which has no name of its
  // own; say whose link it was.
  const invitedLine = (inviter: string) => {
    const linkMaker = inviter !== identity.id && !names.has(inviter) ? invitedBy.get(inviter) : undefined
    return linkMaker ? `by a standing link from ${nameOf(linkMaker)}` : `invited by ${nameOf(inviter)}`
  }

  // Pictures chosen but not yet sent, shown above the message box. What is typed there becomes the caption.
  const [attached, setAttached] = useState<(PreparedImage & {url: string})[]>([])
  const [preparing, setPreparing] = useState(0)
  const [viewing, setViewing] = useState<string | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  // The strip of pictures waiting to be sent takes room from the log; keep the newest message in view.
  useEffect(() => {
    if (atEnd.current) toEnd()
  }, [attached.length, preparing > 0])
  const attachedCount = useRef(0)
  attachedCount.current = attached.length + preparing
  const attach = async (chosen: File[]) => {
    const room = MAX_ATTACHED - attachedCount.current
    if (chosen.length > room) setError(`Up to ${MAX_ATTACHED} pictures can be sent at once.`)
    for (const file of chosen.slice(0, Math.max(0, room))) {
      setPreparing(count => count + 1)
      try {
        const prepared = await prepareImage(file)
        setAttached(current => [...current, {...prepared, url: URL.createObjectURL(prepared.shown)}])
      } catch {
        setError(`"${file.name}" isn't a picture this browser can open.`)
      } finally {
        setPreparing(count => count - 1)
      }
    }
  }
  const detach = (entry: {url: string}) => {
    URL.revokeObjectURL(entry.url)
    setAttached(current => current.filter(other => other !== entry))
  }
  const imagesIn = (list: FileList | null | undefined) => [...(list ?? [])].filter(file => file.type.startsWith('image/'))

  // The message being answered, shown above the message box until the answer is sent or it is dismissed.
  const [replyingTo, setReplyingTo] = useState<MessageRecord | null>(null)
  const messageBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (atEnd.current) toEnd()
  }, [replyingTo])
  // The messages a reply can point at.
  const byKey = useMemo(() => {
    const found = new Map<string, MessageRecord>()
    for (const message of messages ?? []) {
      if (message.content.type === 'text' || message.content.type === 'image') found.set(messageKey(message), message)
    }
    return found
  }, [messages])
  /** What to show of a message where it is quoted: who said it, and its words or what it is. */
  const quoteOf = (message: MessageRecord) => {
    const {content} = message
    const who = message.author === identity.id ? 'You' : nameOf(message.author)
    const words = wordsOf(message).slice(0, 200)
    if (content.type === 'image') return {who, text: words ? `Picture: ${words}` : 'Picture', shown: words || 'Picture', image: content}
    return {who, text: words, shown: words, image: null}
  }
  const quoteBody = (quote: ReturnType<typeof quoteOf>, who = quote.who) => (
    <>
      {quote.image && <QuoteThumb store={store} chatId={chat.id} image={quote.image} held={files.has(quote.image.hash)} />}
      <span class="words">
        <span class="who">{who}</span>
        <span class="said">{quote.shown}</span>
      </span>
    </>
  )
  // Going to a quoted message marks it for a moment, so it can be found among its neighbours.
  const [marked, setMarked] = useState<string | null>(null)
  const markTimer = useRef(0)
  useEffect(() => () => clearTimeout(markTimer.current), [])
  const showMessage = (key: string) => {
    const element = log.current
    const line = [...(element?.children ?? [])].find(child => (child as HTMLElement).dataset.key === key)
    if (!element || !line) return
    const [frame, box] = [element.getBoundingClientRect(), line.getBoundingClientRect()]
    element.scrollTo({top: element.scrollTop + box.top - frame.top - Math.max(0, (frame.height - box.height) / 2), behavior: 'smooth'})
    setMarked(key)
    clearTimeout(markTimer.current)
    markTimer.current = window.setTimeout(() => setMarked(null), 1600)
  }

  // One of our own messages being reworded in the message box. What was being typed is set aside meanwhile.
  const [editing, setEditing] = useState<MessageRecord | null>(null)
  const setAside = useRef('')
  const startEditing = (message: MessageRecord) => {
    setMenu(null)
    setReplyingTo(null)
    if (!editing) setAside.current = draft
    setEditing(message)
    setDraft(wordsOf(message))
    messageBox.current?.focus()
  }
  const stopEditing = () => {
    setEditing(null)
    setDraft(setAside.current)
    setAside.current = ''
  }
  const editLast = () => {
    const last = [...(messages ?? [])].reverse().find(({author, content}) => author === identity.id && (content.type === 'text' || content.type === 'image'))
    if (last) startEditing(last)
    return !!last
  }

  const send = async (event: Event) => {
    event.preventDefault()
    const text = draft.trim()
    if (editing) {
      // A caption can be taken away; a message in words has to say something.
      if (!session.current || (!text && editing.content.type !== 'image')) return
      const changed = text !== wordsOf(editing)
      const {device, seq} = editing
      stopEditing()
      if (changed) await session.current.edit({device, seq}, text).catch(() => setError('The change could not be sent.'))
      return
    }
    if (!session.current || preparing > 0 || (!text && attached.length === 0)) return
    const replyTo: MessageRef | undefined = replyingTo ? {author: replyingTo.author, device: replyingTo.device, seq: replyingTo.seq} : undefined
    setDraft('')
    setReplyingTo(null)
    // The sound for sending comes as it is sent, so that it is clearly the send.
    playSound()
    if (attached.length === 0) return session.current.sendText(text, replyTo).catch(() => setError('Message could not be sent.'))
    const sending = attached
    setAttached([])
    try {
      // The caption goes with the first picture, and so does what it is a reply to.
      for (const [index, {image, file}] of sending.entries()) {
        const first = index === 0 ? {...(text ? {caption: text} : {}), ...(replyTo ? {replyTo} : {})} : {}
        await session.current.postImage({...image, ...first}, file)
      }
    } catch {
      setError('Picture could not be sent.')
    } finally {
      sending.forEach(entry => URL.revokeObjectURL(entry.url))
    }
  }

  // The menu on one message: reactions, and copying its text.
  const [menu, setMenu] = useState<string | null>(null)
  // The full emoji picker, open for one message.
  const [picking, setPicking] = useState<MessageRecord | null>(null)
  const menuOpenedAt = useRef(0)
  const openMenu = (key: string) => {
    menuOpenedAt.current = Date.now()
    setPicking(null)
    setMenu(key)
  }
  /** Scrolls the log just far enough that a menu hanging below its message is all in view. */
  const showMenu = (opened: HTMLElement | null) => {
    const element = log.current
    if (!opened || !element) return
    const below = opened.getBoundingClientRect().bottom + 8 - element.getBoundingClientRect().bottom
    if (below > 0) element.scrollTop += below
  }
  const closeMenu = () => {
    // The finger that opened the menu by pressing also lifts; that must not count as a tap outside it.
    if (Date.now() - menuOpenedAt.current <= 400) return
    setMenu(null)
    setPicking(null)
  }
  // Escape puts a message's menu away. Listening from the moment the menu shows, not a frame later.
  useLayoutEffect(() => {
    if (!menu) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menu])
  const ownReaction = (message: MessageRecord) =>
    reactions.get(messageKey(message))?.find(tally => tally.by.includes(identity.id))?.emoji ?? null
  // From the menu or the message itself, choosing the emoji we already chose takes it away. From the
  // full picker it is left as it is.
  const react = (message: MessageRecord, emoji: string, toggle = true) => {
    setMenu(null)
    setPicking(null)
    const same = ownReaction(message) === emoji
    if (same && !toggle) return
    session.current?.react({author: message.author, device: message.device, seq: message.seq}, same ? '' : emoji).catch(() => setError('Reaction could not be sent.'))
  }
  const replyTo = (message: MessageRecord) => {
    setMenu(null)
    if (editing) stopEditing()
    setReplyingTo(message)
    messageBox.current?.focus()
  }
  const copyText = async (text: string) => {
    setMenu(null)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setError("Couldn't copy the message.")
    }
  }

  // On a touch screen, resting a finger on a message opens its menu.
  const press = useRef<{timer: number; x: number; y: number} | null>(null)
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  const startPress = (event: PointerEvent, key: string) => {
    if (event.pointerType === 'mouse' || menu) return
    cancelPress()
    const timer = window.setTimeout(() => {
      press.current = null
      openMenu(key)
    }, LONG_PRESS_MS)
    press.current = {timer, x: event.clientX, y: event.clientY}
  }
  const movePress = (event: PointerEvent) => {
    const started = press.current
    if (started && Math.hypot(event.clientX - started.x, event.clientY - started.y) > LONG_PRESS_SLOP_PX) cancelPress()
  }
  useEffect(() => cancelPress, [])

  // A group's name being changed, in place of the title. Any member can; everyone gets the new name.
  const [renaming, setRenaming] = useState<string | null>(null)
  const nameBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (renaming !== null) nameBox.current?.select()
  }, [renaming !== null])
  const rename = (event: Event) => {
    event.preventDefault()
    const name = cleanName(renaming ?? '')
    if (!name || !session.current) return
    setRenaming(null)
    if (name !== chatName) session.current.rename(name).catch(() => setError('The name could not be changed.'))
  }

  // Anything half done here would be lost if the tab reloaded to update itself.
  useUpdateHold(draft.trim() !== '' || attached.length > 0 || preparing > 0 || invite !== null || viewing !== null || menu !== null || picking !== null || replyingTo !== null || editing !== null || renaming !== null || profileOf !== null)

  const connected = peers.length > 0
  const routeSummary = describeRoutes(routes)
  const inviteUrl = invite ? location.origin + location.pathname + inviteToFragment(invite) : ''
  const toggleInvite = () => {
    setInviteNote(null)
    setCopied(false)
    // A new token each time, so a code from an earlier showing never works again.
    setInvite(invite ? null : createInvite(identity))
  }

  // "Add someone" in a direct chat: start a group that already includes the other person, tell them
  // through this chat, and go to the group with its invite code up for whoever is being added.
  const addSomeone = async () => {
    if (!session.current) return
    try {
      const taken = (await store.listChats()).map(stored => stored.name)
      const started = groupFromDirect(identity, chat, `Group with ${chatName}`, taken, Date.now())
      await store.saveChat(started.chat)
      await session.current.postGroupInvite(started.invite)
      onOpenChat(started.chat.id, true)
    } catch {
      setError("Couldn't start a group.")
    }
  }

  const openGroupInvite = async (message: MessageRecord) => {
    if (message.content.type !== 'group-invite' || !chat.peer) return
    try {
      const group = chatFromGroupInvite(message.content, chat.peer.signPublic, identity, Date.now())
      const others = (await store.listChats()).filter(stored => stored.id !== group.id).map(stored => stored.name)
      const saved = await store.saveChat({...group, name: uniqueChatName(group.name, others)})
      onOpenChat(saved.id, false)
    } catch {
      setError("That group invite isn't valid.")
    }
  }

  const [standingCopied, setStandingCopied] = useState(false)
  const copyStanding = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname + makeStandingInvite(chat, identity, Date.now()))
      setStandingCopied(true)
      setTimeout(() => setStandingCopied(false), 2000)
    } catch {
      setError("Couldn't copy the link.")
    }
  }

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError("Couldn't copy the link.")
    }
  }

  return (
    <main
      ref={screen}
      class="chat"
      // Pictures can be dropped anywhere on the chat.
      onDragOver={event => event.dataTransfer?.types.includes('Files') && event.preventDefault()}
      onDrop={event => {
        const dropped = imagesIn(event.dataTransfer?.files)
        if (dropped.length === 0) return
        event.preventDefault()
        void attach(dropped)
      }}
    >
      <header>
        <button type="button" class="back" onClick={onBack} aria-label="Back to chats">
          ‹
        </button>
        {renaming !== null ? (
          <form class="rename" onSubmit={rename}>
            <input
              ref={nameBox}
              value={renaming}
              onInput={event => setRenaming(event.currentTarget.value)}
              onKeyDown={event => event.key === 'Escape' && setRenaming(null)}
              maxLength={MAX_NAME_LENGTH}
              aria-label="New name for this chat"
              autocomplete="off"
            />
            <button type="submit" disabled={!cleanName(renaming)}>
              Save
            </button>
            <button type="button" aria-label="Cancel rename" onClick={() => setRenaming(null)}>
              ✕
            </button>
          </form>
        ) : (
        <div class="title">
          <div class="name">
            {peerId && (
              <button type="button" class="person" aria-label={`${chatName}'s profile`} onClick={() => setProfileOf(peerId)}>
                <Avatar card={cards.get(peerId)} name={chatName} id={peerId} />
              </button>
            )}
            <h1>{chatName}</h1>
            {!direct && (
              <button type="button" class="pencil" aria-label="Rename chat" disabled={!messages} onClick={() => setRenaming(chatName)}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
                  <path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L8.5 19z" />
                  <path d="M14.5 6l3.5 3.5" />
                </svg>
              </button>
            )}
          </div>
          {connected ? (
            <p class="status on">{`Connected to ${peers.length}${routeSummary && ` · ${routeSummary}`}`}</p>
          ) : status === 'idle' ? (
            <p class="status">Nobody else is here right now</p>
          ) : (
            <p class="status busy">{BUSY_LABELS[status]}</p>
          )}
        </div>
        )}
        {renaming !== null ? null : direct ? (
          <button type="button" onClick={addSomeone} disabled={!messages}>
            Add someone
          </button>
        ) : (
          <button type="button" onClick={toggleInvite}>
            {invite ? 'Stop inviting' : 'Invite'}
          </button>
        )}
      </header>

      {error && <p class="error">{error}</p>}

      {inviteNote && <p class="note">{inviteNote}</p>}

      {invite && (
        <section class="invite">
          <QrCode text={inviteUrl} label="Invite code for this chat" />
          <p>Anyone who scans this while it is on your screen can join. It stops working when you close it.</p>
          <button type="button" onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
          {devMode() && (
            <div class="standing">
              <button type="button" onClick={copyStanding}>
                {standingCopied ? 'Copied' : 'Copy standing link (testing)'}
              </button>
              <p class="note">
                For showing the app to someone far away. Anyone this link ever reaches can join this chat and read all of it, at any time. It never
                expires and cannot be cancelled, so use it only for chats made for testing.
              </p>
            </div>
          )}
        </section>
      )}

      <ol class="log" ref={log} onScroll={noteScroll}>
        {shown.map((message, index, all) => {
          const mine = message.author === identity.id
          const key = messageKey(message)
          const day = dayKey(message.sentAt)
          const newDay = day !== '' && (index === 0 || day !== dayKey(all[index - 1].sentAt))
          const separator = newDay && (
            <li key={`day:${key}`} class="event day">
              {formatDay(message.sentAt)}
            </li>
          )
          if (message.content.type === 'profile') {
            const inviter = invitedBy.get(message.author)
            return [
              separator,
              <li key={key} class="event">
                {message.author === founderId
                  ? `${message.content.name} started this chat`
                  : `${message.content.name} joined${inviter ? ` · ${invitedLine(inviter)}` : ''}`}
              </li>
            ]
          }
          if (message.content.type === 'rename') {
            return [
              separator,
              <li key={key} class="event">
                {mine ? 'You' : nameOf(message.author)} changed the name to “{message.content.name}”
              </li>
            ]
          }
          if (message.content.type === 'group-invite') {
            return [
              separator,
              <li key={key} class="event">
                {mine ? (
                  `You started the group "${message.content.name}" with ${chatName}`
                ) : (
                  <>
                    {nameOf(message.author)} added you to the group "{message.content.name}"{' '}
                    <button type="button" class="inline" onClick={() => openGroupInvite(message)}>
                      Open
                    </button>
                  </>
                )}
              </li>
            ]
          }
          if (message.content.type !== 'text' && message.content.type !== 'image') return separator
          const image = message.content.type === 'image' ? message.content : null
          const text = wordsOf(message)
          const edited = edits.has(key)
          const size = image ? null : emojiSize(text)
          const tallies = reactions.get(key)
          const own = ownReaction(message)
          const open = menu === key
          const card = cards.get(message.author)
          const replied = message.content.replyTo
          const original = replied && byKey.get(messageKey(replied))
          const quote = original && quoteOf(original)
          return [
            separator,
            <li
              key={key}
              data-key={key}
              class={`${mine ? 'mine' : 'theirs'}${image ? ' image' : ''}${size && !replied ? ` ${size}` : ''}${tallies ? ' reacted' : ''}${open ? ' menu-open' : ''}${marked === key || (editing && messageKey(editing) === key) ? ' marked' : ''}${!mine && card?.color ? ' tinted' : ''}`}
              style={!mine && card?.color ? {'--tint': card.color} : undefined}
              onPointerDown={event => startPress(event, key)}
              onPointerMove={movePress}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onPointerLeave={cancelPress}
              // A long press must open our menu, not the browser's.
              onContextMenu={event => (press.current || open) && event.preventDefault()}
            >
              {!mine && (
                <span class="author">
                  <Avatar card={card} name={nameOf(message.author)} id={message.author} />
                  {nameOf(message.author)}
                </span>
              )}
              {replied &&
                (quote ? (
                  <button
                    type="button"
                    class="quote"
                    aria-label={`In reply to ${quote.who}: ${quote.text}`}
                    // The tap that ends a long press must not also go to the quoted message.
                    onClick={() => !menu && Date.now() - menuOpenedAt.current > 700 && showMessage(messageKey(original!))}
                  >
                    {quoteBody(quote)}
                  </button>
                ) : (
                  <span class="quote gone">A message that isn't on this device</span>
                ))}
              {image && (
                <ImageView
                  store={store}
                  chatId={chat.id}
                  image={image}
                  held={files.has(image.hash)}
                  connected={connected}
                  from={nameOf(message.author)}
                  // The tap that ends a long press must not also open the picture.
                  onOpen={url => !menu && Date.now() - menuOpenedAt.current > 700 && setViewing(url)}
                />
              )}
              {image
                ? text && <span class="caption">{splitEmoji(text).map(segment => (segment.emoji ? <span class="emoji">{segment.text}</span> : segment.text))}</span>
                : splitEmoji(text).map(segment => (segment.emoji ? <span class="emoji">{segment.text}</span> : segment.text))}
              <time class="time" dateTime={new Date(message.sentAt).toISOString()}>
                {edited && 'edited · '}
                {formatTime(message.sentAt)}
              </time>
              {tallies && (
                <span class="reactions">
                  {tallies.map(tally => {
                    const who = tally.by.map(nameOf).join(', ')
                    return (
                      <button
                        key={tally.emoji}
                        type="button"
                        class={tally.by.includes(identity.id) ? 'own' : ''}
                        aria-label={`${tally.emoji} from ${who}`}
                        title={who}
                        onClick={() => react(message, tally.emoji)}
                      >
                        {tally.emoji}
                        {tally.by.length > 1 && <span class="count">{tally.by.length}</span>}
                      </button>
                    )
                  })}
                </span>
              )}
              <button type="button" class="react" aria-label="React or copy" aria-expanded={open} onClick={() => (open ? setMenu(null) : openMenu(key))}>
                ☺
              </button>
              {open && (
                <div class="menu" ref={showMenu}>
                  <div class="quick">
                    {QUICK_REACTIONS.map(emoji => (
                      <button key={emoji} type="button" class={own === emoji ? 'own' : ''} aria-label={`React ${emoji}`} onClick={() => react(message, emoji)}>
                        {emoji}
                      </button>
                    ))}
                    <button
                      type="button"
                      aria-label="Another emoji"
                      onClick={() => {
                        setMenu(null)
                        setPicking(message)
                      }}
                    >
                      ＋
                    </button>
                  </div>
                  {tallies && <p class="who">{tallies.map(tally => `${tally.emoji} ${tally.by.map(nameOf).join(', ')}`).join(' · ')}</p>}
                  <button type="button" class="reply" onClick={() => replyTo(message)}>
                    Reply
                  </button>
                  <button
                    type="button"
                    class="reply"
                    onClick={() => {
                      setMenu(null)
                      setProfileOf(message.author)
                    }}
                  >
                    {mine ? 'Your profile' : `${nameOf(message.author)}'s profile`}
                  </button>
                  {mine && (
                    <button type="button" class="reply" onClick={() => startEditing(message)}>
                      {image ? (text ? 'Edit caption' : 'Add a caption') : 'Edit'}
                    </button>
                  )}
                  {/* Shows what will be copied, as much of it as fits. */}
                  {text && (
                    <button type="button" class="copy" aria-label={`Copy “${text.slice(0, 120)}”`} onClick={() => copyText(text)}>
                      Copy “<span class="snippet">{text.slice(0, 120)}</span>”
                    </button>
                  )}
                </div>
              )}
            </li>
          ]
        })}
      </ol>

      {(menu || picking) && <div class="menu-backdrop" onClick={closeMenu} />}
      {picking && <EmojiPicker onPick={emoji => react(picking, emoji, false)} onClose={() => setPicking(null)} />}

      {viewing && <ImageViewer url={viewing} onClose={() => setViewing(null)} />}
      {profileOf && (
        <ProfileCard
          name={profileOf === identity.id ? identity.name : profileOf === peerId ? chatName : nameOf(profileOf)}
          id={profileOf}
          card={cards.get(profileOf)}
          store={store}
          chatId={chat.id}
          files={files}
          own={
            profileOf === identity.id
              ? {
                  parts: PARTS.filter(part => hasPart(ownProfile, part)).map(part => ({
                    part,
                    everywhere: ownProfile.show[part].everywhere,
                    shown: showsIn(ownProfile, part, chat.id)
                  })),
                  onShow: showOwnProfile
                }
              : undefined
          }
          onClose={() => setProfileOf(null)}
        />
      )}

      {replyingTo && (
        <p class="replying">
          <span class="quote">{quoteBody(quoteOf(replyingTo), `Replying to ${replyingTo.author === identity.id ? 'yourself' : nameOf(replyingTo.author)}`)}</span>
          <button type="button" aria-label="Cancel reply" onClick={() => setReplyingTo(null)}>
            ✕
          </button>
        </p>
      )}
      {editing && (
        <p class="replying">
          <span class="quote">{quoteBody(quoteOf(editing), editing.content.type === 'image' ? 'Editing your caption' : 'Editing your message')}</span>
          <button type="button" aria-label="Cancel edit" onClick={stopEditing}>
            ✕
          </button>
        </p>
      )}

      {(attached.length > 0 || preparing > 0) && (
        <ul class="attached" aria-label="Pictures to send">
          {attached.map((entry, index) => (
            <li key={entry.url}>
              <img src={entry.url} alt={`Picture ${index + 1} to send`} />
              <button type="button" aria-label={`Remove picture ${index + 1}`} onClick={() => detach(entry)}>
                ✕
              </button>
            </li>
          ))}
          {preparing > 0 && <li class="busy">Preparing…</li>}
        </ul>
      )}

      <form class="composer" onSubmit={send}>
        <input
          ref={filePicker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Pictures to add"
          onChange={event => {
            void attach(imagesIn(event.currentTarget.files))
            // So that choosing the same picture again is noticed.
            event.currentTarget.value = ''
          }}
        />
        <button type="button" class="attach" aria-label="Add a picture" disabled={!messages || editing !== null} onClick={() => filePicker.current?.click()}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
            <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
          </svg>
        </button>
        <input
          ref={messageBox}
          value={draft}
          onInput={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') editing ? stopEditing() : setReplyingTo(null)
            // As in other chat apps: the up arrow in an empty box rewords the last thing we said.
            else if (event.key === 'ArrowUp' && !editing && draft === '' && attached.length === 0 && editLast()) event.preventDefault()
          }}
          onPaste={event => {
            const pasted = imagesIn(event.clipboardData?.files)
            if (pasted.length === 0) return
            event.preventDefault()
            void attach(pasted)
          }}
          placeholder={editing ? (editing.content.type === 'image' ? 'Caption (leave empty for none)' : 'Message') : attached.length > 0 ? 'Add a caption (optional)' : connected ? 'Message' : 'Message (delivered when you are both here)'}
          maxLength={MAX_TEXT_LENGTH}
          aria-label="Message"
          autocomplete="off"
        />
        {editing ? (
          <button type="submit" disabled={!draft.trim() && editing.content.type !== 'image'}>
            Save
          </button>
        ) : (
          <button type="submit" disabled={!messages || preparing > 0 || (!draft.trim() && attached.length === 0)}>
            Send
          </button>
        )}
      </form>
    </main>
  )
}
