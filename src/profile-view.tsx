// Profiles on screen: the small icon beside a name, the card that pops up for a person, and the
// editor for one's own.
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'preact/hooks'
import {COLORS, CONTACT_KINDS, CONTACT_LABELS, contactLink, fallbackHue, type ContactKind} from './cards'
import {EmojiPicker} from './emoji-picker'
import {Emoji} from './emoji-view'
import {onProfileTakenUp} from './devices'
import {IMAGE_MIME, MAX_CONTACT_LENGTH, type CardContent, type PictureRef} from './envelope'
import {cleanName, loadIdentity, MAX_NAME_LENGTH, type Identity} from './identity'
import {openImage, prepareAvatar, prepareImage} from './image'
import {useImageUrl} from './image-view'
import {Sheet} from './sheet'
import {ALTERABLE, asIn, hasPart, isInstead, loadProfile, PART_LABELS, PARTS, PROFILE_FILES, profileCard, saveProfile, showsIn, type Alterable, type Instead, type Part, type Profile} from './profile'
import type {Store} from './store'

/** The longest side of a profile photo. */
const PHOTO_SIDE = 800

function useBytesUrl(bytes: Uint8Array | undefined): string | null {
  const url = useMemo(() => (bytes?.length ? URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: IMAGE_MIME})) : null), [bytes])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  return url
}

/** A person's icon: their tiny photo or emoji, or else their initial on a colour of their own. */
export function Avatar(props: {card?: CardContent; name: string; id: string; large?: boolean}) {
  const {card, name, id, large} = props
  const url = useBytesUrl(card?.avatar)
  const size = large ? ' large' : ''
  if (url) return <img class={`avatar${size}`} src={url} alt="" draggable={false} />
  if (card?.icon)
    return (
      <span class={`avatar emoji${size}`}>
        <Emoji emoji={card.icon} />
      </span>
    )
  return (
    // Drawn by the stylesheet, so the letter is not read or copied as part of the name beside it.
    <span
      class={`avatar initial${size}`}
      data-initial={[...name.trim()][0]?.toUpperCase() ?? '?'}
      style={{background: card?.color ?? `hsl(${fallbackHue(id)} 45% 45%)`}}
      aria-hidden="true"
    />
  )
}

function Contact(props: {contact: NonNullable<CardContent['contact']>}) {
  const {contact} = props
  const link = contactLink(contact)
  return (
    <p class="contact">
      <span class="kind">{CONTACT_LABELS[contact.kind]}</span>{' '}
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer">
          {contact.value}
        </a>
      ) : (
        contact.value
      )}
    </p>
  )
}

function Photo(props: {store: Store; chatId: string; photo: PictureRef; held: boolean}) {
  const {store, chatId, photo, held} = props
  const url = useImageUrl(store, chatId, {type: 'image', ...photo}, held)
  const preview = useBytesUrl(photo.preview)
  return (
    <span class="photo" style={{aspectRatio: `${photo.width} / ${photo.height}`}}>
      {preview && <img class="blur" src={preview} alt="" />}
      {url && <img src={url} alt="Profile photo" draggable={false} />}
    </span>
  )
}

function useEscape(onClose: () => void) {
  // Listening from the moment the sheet shows, not a frame later.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

/** One person's profile, as they show it in this chat. For our own, also where it is switched on here. */
/** In a chat, our own profile part by part: shown here or not, and the usual or something else here. */
function OwnHere(props: {
  profile: Profile
  chatId: string
  name: string
  id: string
  /** Our usual name. */
  usualName: string
  onShow: (part: Part, shown: boolean) => void
  onInstead: (part: Alterable, value: Instead | null) => void
  onName: (name: string | null) => void
  onPickEmoji: () => void
}) {
  const {profile, chatId, name, id, usualName, onShow, onInstead, onName, onPickEmoji} = props
  const [naming, setNaming] = useState(false)
  const [nameHere, setNameHere] = useState(profile.instead?.[chatId]?.name ?? '')
  // The part whose something-else is being chosen, before anything is chosen.
  const [choosing, setChoosing] = useState<Alterable | null>(null)
  const here = asIn(profile, chatId)
  const alterable = (part: Part): part is Alterable => (ALTERABLE as readonly string[]).includes(part)
  // Anything that can be something else here is offered, even where the usual profile has none: a phone
  // number, say, only for someone in particular. The photo is offered once there is one.
  const parts = PARTS.filter(part => alterable(part) || hasPart(profile, part))
  const named = !!profile.instead?.[chatId]?.name
  const colourName = (value?: string) => COLORS.find(([, color]) => color === value)?.[0] ?? 'your colour'
  const usualOf = (part: Part) =>
    part === 'icon' ? (profile.icon ?? (profile.avatar ? 'your tiny photo' : 'none')) : part === 'color' ? (profile.color ? colourName(profile.color) : 'none') : part === 'contact' ? (profile.contact?.value ?? 'none') : ''
  const status = (part: Part, shown: boolean) => {
    const {everywhere} = profile.show[part]
    if (!shown) return everywhere ? 'Shown in every chat but this one' : 'Not shown here'
    return everywhere ? 'Shown in every chat' : 'Shown here'
  }
  return (
    <div class="own-here">
      <div class="part">
        <span class="label">
          Name{named && <span class="here"> just here</span>}
        </span>
        <p class="note">{named ? `Your usual is ${usualName}` : 'Always shown'}</p>
        {!naming && !named && (
          <div class="row value">
            <span>{name}</span>
            <button type="button" class="link" onClick={() => setNaming(true)}>
              Use another name here
            </button>
          </div>
        )}
        {(naming || named) && (
          <form
            class="row value"
            onSubmit={event => {
              event.preventDefault()
              const wanted = cleanName(nameHere)
              if (wanted) onName(wanted === usualName ? null : wanted)
              setNaming(false)
            }}
          >
            <input value={nameHere} onInput={event => setNameHere(event.currentTarget.value)} maxLength={MAX_NAME_LENGTH} aria-label="Name here" autocomplete="off" />
            <button type="submit" disabled={!cleanName(nameHere)}>
              Use here
            </button>
          </form>
        )}
        {(naming || named) && (
          <button
            type="button"
            class="link"
            onClick={() => {
              setNaming(false)
              setNameHere('')
              if (named) onName(null)
            }}
          >
            {named ? 'Back to my usual' : 'Keep my usual'}
          </button>
        )}
      </div>
      {parts.map(part => {
        const has = hasPart(asIn(profile, chatId), part)
        const shown = showsIn(profile, part, chatId)
        const instead = alterable(part) && isInstead(profile, part, chatId)
        const open = alterable(part) && (instead || choosing === part)
        return (
          <div class="part" key={part}>
            <label>
              <input type="checkbox" checked={shown} onChange={event => onShow(part, event.currentTarget.checked)} /> {PART_LABELS[part]}
              {instead && <span class="here"> just here</span>}
            </label>
            <p class="note">{instead ? `Your usual is ${usualOf(part)}` : has ? status(part, shown) : 'None yet'}</p>
            {!open && part !== 'photo' && (
              <div class="row value">
                {part === 'icon' && <Avatar card={profileCard(here)} name={name} id={id} />}
                {part === 'color' && here.color && <span class="swatch" style={{background: here.color}} aria-hidden="true" />}
                {part === 'contact' && here.contact && <span>{here.contact.value}</span>}
                <button type="button" class="link" onClick={() => setChoosing(part as Alterable)}>
                  {has ? 'Use something else here' : 'Add one for this chat'}
                </button>
              </div>
            )}
            {open && part === 'icon' && (
              <div class="row value">
                <Avatar card={profileCard(here)} name={name} id={id} />
                <button type="button" onClick={onPickEmoji}>
                  Emoji
                </button>
              </div>
            )}
            {open && part === 'color' && (
              <div class="row swatches">
                {COLORS.map(([label, value]) => (
                  <button
                    key={value}
                    type="button"
                    class={`swatch${here.color === value && instead ? ' chosen' : ''}`}
                    style={{background: value}}
                    aria-label={`${label} here`}
                    aria-pressed={here.color === value && instead}
                    onClick={() => onInstead('color', {color: value})}
                  />
                ))}
              </div>
            )}
            {open && part === 'contact' && (
              <ContactHere
                start={here.contact}
                onSave={contact => onInstead('contact', {contact})}
              />
            )}
            {open && (
              <button
                type="button"
                class="link"
                onClick={() => {
                  setChoosing(null)
                  if (instead) onInstead(part as Alterable, null)
                }}
              >
                {instead ? 'Back to my usual' : 'Keep my usual'}
              </button>
            )}
          </div>
        )
      })}
      <p class="note">
        Tick to show something here, untick to hide it here; anyone who has already seen it may have kept it. Changes here are for this chat only. Your
        usual profile is set from the front page, and is the same on all your devices.
      </p>
    </div>
  )
}

/** A contact to show in one chat instead of the usual one. */
function ContactHere(props: {start?: {kind: ContactKind; value: string}; onSave: (contact: {kind: ContactKind; value: string}) => void}) {
  const [kind, setKind] = useState<ContactKind>(props.start?.kind ?? 'email')
  const [value, setValue] = useState(props.start?.value ?? '')
  return (
    <form
      class="row value"
      onSubmit={event => {
        event.preventDefault()
        if (value.trim()) props.onSave({kind, value: value.trim()})
      }}
    >
      <select aria-label="Kind of contact here" value={kind} onChange={event => setKind(event.currentTarget.value as ContactKind)}>
        {CONTACT_KINDS.map(option => (
          <option key={option} value={option}>
            {CONTACT_LABELS[option]}
          </option>
        ))}
      </select>
      <input value={value} onInput={event => setValue(event.currentTarget.value)} maxLength={MAX_CONTACT_LENGTH} aria-label="Contact here" autocomplete="off" autocapitalize="off" />
      <button type="submit" disabled={!value.trim()}>
        Use here
      </button>
    </form>
  )
}

export function ProfileCard(props: {
  name: string
  id: string
  card?: CardContent
  store: Store
  chatId: string
  files: ReadonlySet<string>
  /** Set when the profile is our own. */
  own?: {
    profile: Profile
    usualName: string
    onShow: (part: Part, shown: boolean) => void
    onInstead: (part: Alterable, value: Instead | null) => void
    onName: (name: string | null) => void
  }
  onClose: () => void
}) {
  const {name, id, card, store, chatId, files, own, onClose} = props
  // Choosing an emoji for this chat; Escape closes the picker first.
  const [picking, setPicking] = useState(false)
  const pickingNow = useRef(false)
  pickingNow.current = picking
  useEscape(() => !pickingNow.current && onClose())
  return (
    <>
    <Sheet class="profile" label={own ? 'Your profile' : `${name}'s profile`} title={own ? 'Your profile in this chat' : 'Profile'} onClose={onClose}>
        {card?.photo && <Photo store={store} chatId={chatId} photo={card.photo} held={files.has(card.photo.hash)} />}
        <div class="who">
          <Avatar card={card} name={name} id={id} large />
          <h2>{name}</h2>
          {card?.color && <span class="swatch" style={{background: card.color}} aria-hidden="true" />}
        </div>
        {card?.contact && <Contact contact={card.contact} />}
        {!card && !own && <p class="note">{name} isn't showing a profile in this chat.</p>}
        {own && (
          <OwnHere
            profile={own.profile}
            chatId={chatId}
            name={name}
            id={id}
            usualName={own.usualName}
            onShow={own.onShow}
            onInstead={own.onInstead}
            onName={own.onName}
            onPickEmoji={() => setPicking(true)}
          />
        )}
        <button type="button" onClick={onClose}>
          Done
        </button>
    </Sheet>
      {/* Beside the sheet, not inside it: a tap in the picker must not count as a tap on what is behind. */}
      {picking && own && (
        <div class="over-sheet">
          <EmojiPicker
            onPick={emoji => {
              own.onInstead('icon', {icon: emoji})
              setPicking(false)
            }}
            onClose={() => setPicking(false)}
          />
        </div>
      )}
    </>
  )
}

/** The person's own profile, from the front page. It goes to their other devices; to nobody else until shown in a chat. */
export function ProfileEditor(props: {store: Store; identity: Identity; onIdentity: (identity: Identity) => void; onClose: () => void}) {
  const {store, identity, onIdentity, onClose} = props
  const [profile, setProfile] = useState<Profile>(loadProfile)
  const [name, setName] = useState(identity.name)
  const [picking, setPicking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // The chosen photo, sealed and waiting to be saved; `null` once the photo has been removed.
  const [newPhoto, setNewPhoto] = useState<{file: Uint8Array; shown: Blob} | null>(null)
  const avatarPicker = useRef<HTMLInputElement>(null)
  const photoPicker = useRef<HTMLInputElement>(null)
  // Escape closes the picker first, if it is open.
  const pickingNow = useRef(false)
  pickingNow.current = picking
  useEscape(() => !pickingNow.current && onClose())

  const change = (part: Partial<Profile>) => setProfile(current => ({...current, ...part}))
  const chooseAvatar = async (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    try {
      change({avatar: await prepareAvatar(file)})
    } catch {
      setProblem("That isn't a picture this browser can open.")
    }
  }
  const choosePhoto = async (file: File | undefined) => {
    if (!file) return
    setProblem(null)
    try {
      const {image, file: sealed, shown} = await prepareImage(file, undefined, PHOTO_SIDE)
      const {hash, key, size, width, height, preview} = image
      setNewPhoto({file: sealed, shown})
      change({photo: {hash, key, size, width, height, preview}})
    } catch {
      setProblem("That isn't a picture this browser can open.")
    }
  }

  // The photo as it will look: the one just chosen, or the one saved earlier.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    const show = (blob: Blob) => {
      if (cancelled) return
      made = URL.createObjectURL(blob)
      setPhotoUrl(made)
    }
    const {photo} = profile
    // Taken up from another device, the photo may come in after the rest; it is looked for again then.
    const load = () => {
      if (!photo || made) return
      void store.getFile(PROFILE_FILES, photo.hash).then(file => (file && !made ? openImage(file, photo).then(show) : undefined), () => {})
    }
    let stop = () => {}
    if (!photo) setPhotoUrl(null)
    else if (newPhoto) show(newPhoto.shown)
    else {
      load()
      stop = onProfileTakenUp(load)
    }
    return () => {
      cancelled = true
      stop()
      if (made) URL.revokeObjectURL(made)
    }
  }, [profile.photo?.hash])

  const save = async (event: Event) => {
    event.preventDefault()
    const called = cleanName(name)
    if (!called) return
    try {
      if (profile.photo && newPhoto) await store.putFile(PROFILE_FILES, profile.photo.hash, newPhoto.file)
      saveProfile(profile)
      if (called !== identity.name) {
        // The device's tag stays: without it this device would number its messages like the person's first.
        const secrets = {name: called, signSecret: identity.signSecret, dhSecret: identity.dhSecret, ...(identity.device ? {device: identity.device} : {})}
        await store.saveIdentity(secrets)
        onIdentity(loadIdentity(secrets))
      }
      onClose()
    } catch {
      setProblem("Couldn't save your profile.")
    }
  }

  const everywhere = (part: Part) => (
    <label class="everywhere">
      <input
        type="checkbox"
        checked={profile.show[part].everywhere}
        aria-label={`Show my ${PART_LABELS[part].toLowerCase()} in every chat`}
        onChange={event => change({show: {...profile.show, [part]: {...profile.show[part], everywhere: event.currentTarget.checked}}})}
      />{' '}
      Show in every chat
    </label>
  )

  const card = profileCard(profile)
  return (
    <>
    <Sheet class="profile-editor" label="Your profile" title="Your profile" onClose={onClose} onBackdrop={() => (picking ? setPicking(false) : onClose())}>
       <form onSubmit={save}>
        <label>
          Name
          <input value={name} onInput={event => setName(event.currentTarget.value)} maxLength={MAX_NAME_LENGTH} required autocomplete="off" />
        </label>
        <p class="note">
          Everything below is optional, and each part is shown only where you choose: in every chat, or just in the chats where you turn it on. To do
          that, or to hide in one chat what is shown in every chat, open your own profile inside the chat, from the menu on one of your messages. Your
          name is always shown.
        </p>

        <fieldset>
          <legend>Icon</legend>
          <div class="row">
            <Avatar card={card} name={name || '?'} id={identity.id} large />
            <button type="button" onClick={() => setPicking(true)}>
              Emoji
            </button>
            <button type="button" onClick={() => avatarPicker.current?.click()}>
              Tiny photo
            </button>
            {(profile.icon || profile.avatar) && (
              <button type="button" onClick={() => change({icon: undefined, avatar: undefined})}>
                None
              </button>
            )}
          </div>
          <input
            ref={avatarPicker}
            type="file"
            accept="image/*"
            hidden
            aria-label="Tiny photo for your icon"
            onChange={event => {
              void chooseAvatar(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          {everywhere('icon')}
        </fieldset>

        <fieldset>
          <legend>Colour of your messages</legend>
          <div class="row swatches">
            {COLORS.map(([label, value]) => (
              <button
                key={value}
                type="button"
                class={`swatch${profile.color === value ? ' chosen' : ''}`}
                style={{background: value}}
                aria-label={label}
                aria-pressed={profile.color === value}
                onClick={() => change({color: profile.color === value ? undefined : value})}
              />
            ))}
          </div>
          {everywhere('color')}
        </fieldset>

        <fieldset>
          <legend>One way to reach you</legend>
          <div class="row">
            <select
              aria-label="Kind of contact"
              value={profile.contact?.kind ?? ''}
              onChange={event => {
                const kind = event.currentTarget.value as ContactKind | ''
                change({contact: kind ? {kind, value: profile.contact?.value ?? ''} : undefined})
              }}
            >
              <option value="">None</option>
              {CONTACT_KINDS.map(kind => (
                <option key={kind} value={kind}>
                  {CONTACT_LABELS[kind]}
                </option>
              ))}
            </select>
            {profile.contact && (
              <input
                value={profile.contact.value}
                onInput={event => change({contact: {kind: profile.contact!.kind, value: event.currentTarget.value}})}
                maxLength={MAX_CONTACT_LENGTH}
                aria-label="Contact"
                placeholder={
                  {email: 'you@example.com', phone: '+1 555 0100', instagram: '@handle', other: 'App and handle'}[profile.contact.kind]
                }
                autocomplete="off"
                autocapitalize="off"
              />
            )}
          </div>
          {everywhere('contact')}
        </fieldset>

        <fieldset>
          <legend>Photo</legend>
          {photoUrl && <img class="photo-preview" src={photoUrl} alt="Your profile photo" />}
          <div class="row">
            <button type="button" onClick={() => photoPicker.current?.click()}>
              {profile.photo ? 'Change photo' : 'Choose a photo'}
            </button>
            {profile.photo && (
              <button
                type="button"
                onClick={() => {
                  setNewPhoto(null)
                  change({photo: undefined})
                }}
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={photoPicker}
            type="file"
            accept="image/*"
            hidden
            aria-label="Profile photo"
            onChange={event => {
              void choosePhoto(event.currentTarget.files?.[0])
              event.currentTarget.value = ''
            }}
          />
          {everywhere('photo')}
        </fieldset>


        {problem && <p class="error">{problem}</p>}
        <div class="row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={!cleanName(name)}>
            Save
          </button>
        </div>
       </form>
    </Sheet>
      {/* Beside the sheet, not inside it: a tap in the picker must not count as a tap on what is behind. */}
      {picking && (
        <div class="over-sheet">
          <EmojiPicker
            onPick={emoji => {
              change({icon: emoji, avatar: undefined})
              setPicking(false)
            }}
            onClose={() => setPicking(false)}
          />
        </div>
      )}
    </>
  )
}
