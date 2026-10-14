// Installing the app to the home screen, where the browser offers it.
import {useEffect, useState} from 'preact/hooks'

type InstallPrompt = Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>}

let offered: InstallPrompt | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())

/** Whether this is the installed app, opened from its icon, and not a page in a browser. */
export const installed = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & {standalone?: boolean}).standalone === true

/** iPhones and iPads, where the installed app keeps its own storage, apart from the browser's. */
export const onIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Call once at startup: registers the service worker and listens for the browser's offer to install. */
export function setUpInstall(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // After the page has loaded, so it never competes with the app's own start.
    addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => {}))
  }
  // Chrome and its relatives say when the app can be installed, and let the page show its own button.
  addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    offered = event as InstallPrompt
    changed()
  })
  addEventListener('appinstalled', () => {
    offered = null
    changed()
  })
}

/** A function that asks the browser to install the app, or null when the browser is not offering. */
export function useInstall(): (() => Promise<void>) | null {
  const [, refresh] = useState(0)
  useEffect(() => {
    const listener = () => refresh(count => count + 1)
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [])
  if (!offered || installed()) return null
  const prompt = offered
  return async () => {
    await prompt.prompt()
    // An offer can be used once, whatever the answer.
    await prompt.userChoice.catch(() => {})
    offered = null
    changed()
  }
}
