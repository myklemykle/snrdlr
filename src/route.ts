/** How data reaches a peer: over the local network, hole-punched across the internet, or via the TURN relay. */
export type Route = 'local' | 'direct' | 'relayed'

type Stat = {id: string; type: string; [field: string]: unknown}
type StatsReport = {forEach: (callback: (stat: Stat) => void) => void}

/** Reads the route in use from an RTCPeerConnection stats report, or null if no candidate pair is selected yet. */
export function routeFromStats(report: StatsReport): Route | null {
  const byId = new Map<string, Stat>()
  let selectedPairId: unknown
  report.forEach(stat => {
    byId.set(stat.id, stat)
    if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedPairId = stat.selectedCandidatePairId
  })

  // Not every browser reports a transport entry, so fall back to the pair's own flags.
  const pair =
    (typeof selectedPairId === 'string' ? byId.get(selectedPairId) : undefined) ??
    [...byId.values()].find(
      stat => stat.type === 'candidate-pair' && (stat.selected === true || (stat.nominated === true && stat.state === 'succeeded'))
    )
  if (!pair) return null

  const types = [pair.localCandidateId, pair.remoteCandidateId].map(id =>
    typeof id === 'string' ? byId.get(id)?.candidateType : undefined
  )
  if (types.includes('relay')) return 'relayed'
  if (types.includes(undefined)) return null
  return types.every(type => type === 'host') ? 'local' : 'direct'
}

const LABELS: Record<Route, string> = {local: 'local network', direct: 'direct', relayed: 'relayed'}

/** "direct" for one peer; "2 direct, 1 relayed" for several. Empty while routes are unknown. */
export function describeRoutes(routes: Route[]): string {
  if (routes.length === 0) return ''
  if (routes.length === 1) return LABELS[routes[0]]
  return (Object.keys(LABELS) as Route[])
    .map(route => ({route, count: routes.filter(entry => entry === route).length}))
    .filter(({count}) => count > 0)
    .map(({route, count}) => `${count} ${LABELS[route]}`)
    .join(', ')
}
