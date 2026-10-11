import {describe, expect, it} from 'vitest'
import {describeRoutes, routeFromStats} from './route'

type Stat = {id: string; type: string; [field: string]: unknown}

const report = (...stats: Stat[]) => new Map(stats.map(stat => [stat.id, stat]))
const candidate = (id: string, candidateType: string): Stat => ({
  id,
  type: id.startsWith('L') ? 'local-candidate' : 'remote-candidate',
  candidateType
})
const selectedPair = (local: string, remote: string): Stat[] => [
  {id: 'T', type: 'transport', selectedCandidatePairId: 'P'},
  {id: 'P', type: 'candidate-pair', localCandidateId: local, remoteCandidateId: remote}
]

describe('routeFromStats', () => {
  it('reports the local network when both ends use host candidates', () => {
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'host'), candidate('R1', 'host')))).toBe('local')
  })

  it('reports direct when a hole-punched address is in use', () => {
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'srflx'), candidate('R1', 'host')))).toBe('direct')
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'host'), candidate('R1', 'prflx')))).toBe('direct')
  })

  it('reports relayed when either end goes through TURN', () => {
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'relay'), candidate('R1', 'srflx')))).toBe('relayed')
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'host'), candidate('R1', 'relay')))).toBe('relayed')
  })

  it('ignores candidate pairs that were tried but not selected', () => {
    const stats = report(
      ...selectedPair('L1', 'R1'),
      {id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1', nominated: false, state: 'succeeded'},
      candidate('L1', 'host'),
      candidate('L2', 'relay'),
      candidate('R1', 'host')
    )
    expect(routeFromStats(stats)).toBe('local')
  })

  it('falls back to the nominated pair when the browser reports no transport entry', () => {
    const stats = report(
      {id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', nominated: false, state: 'failed'},
      {id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1', nominated: true, state: 'succeeded'},
      candidate('L1', 'host'),
      candidate('L2', 'relay'),
      candidate('R1', 'srflx')
    )
    expect(routeFromStats(stats)).toBe('relayed')
  })

  it('returns null until a pair is selected and its candidates are known', () => {
    expect(routeFromStats(report())).toBeNull()
    expect(routeFromStats(report(candidate('L1', 'host'), candidate('R1', 'host')))).toBeNull()
    expect(routeFromStats(report(...selectedPair('L1', 'R1'), candidate('L1', 'host')))).toBeNull()
  })
})

describe('describeRoutes', () => {
  it('names the route for a single peer', () => {
    expect(describeRoutes(['local'])).toBe('local network')
    expect(describeRoutes(['relayed'])).toBe('relayed')
  })

  it('counts routes for several peers', () => {
    expect(describeRoutes(['relayed', 'direct', 'direct'])).toBe('2 direct, 1 relayed')
    expect(describeRoutes(['local', 'local'])).toBe('2 local network')
  })

  it('is empty while routes are unknown', () => {
    expect(describeRoutes([])).toBe('')
  })
})
