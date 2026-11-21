export const domains = ['safety', 'transit', 'housing', 'medical', 'policing'] as const
export type Domain = typeof domains[number]
export type Weights = Record<Exclude<Domain, 'policing'>, number> & { policing?: number }
export type Scores = Record<Exclude<Domain, 'policing'>, number> & { policing?: number }
export type LeaseType = 'monthly' | 'jeonse'
export interface DataAvailability {
  id: string; name: string; status: 'complete' | 'missing_key' | 'unauthorized' | 'failed' | 'not_configured'
  checkedAt: string; rows?: number; message?: string
}
export interface Transaction {
  id: string; depositKrw: number; monthlyRentKrw: number; areaM2: number
  contractDate: string; housingType: string; leaseType: 'monthly' | 'jeonse'
}
export interface Source {
  id: string; name: string; provider: string; url: string; license: string
  observedDate: string; retrievedAt: string
}
export interface Evidence { label: string; value: string; sourceId: string }
export interface WalkingRoute {
  status: 'ok' | 'no_nearby_walkway' | 'no_connected_entrance' | 'unavailable'
  sourceId: string; checkedAt: string
  origin?: { latitude: number; longitude: number }
  distanceM?: number; durationSeconds?: number; originSnapM?: number; destinationSnapM?: number
  entranceNodeId?: string; entranceName?: string; entranceRef?: string
  destinationType?: string; method?: string; startDefinition?: string; speedKmh?: number
  geometry?: GeoJSON.LineString
}
export interface Area {
  crime?: { district: string; year: number; cases: number; population: number; per100k: number }
  code: string; name: string; district: string; latitude: number; longitude: number
  // Real boundaries only; never synthesize an administrative boundary from a center point.
  boundary?: GeoJSON.Polygon | GeoJSON.MultiPolygon
  scores: Record<'safety' | 'transit' | 'medical', number | null> & { policing?: number | null }
  evidence: Evidence[]; transactions: Transaction[]; flags: string[]
  rentalGroups?: { depositKrw: number; monthlyRentKrw: number; count: number }[]
  jeonseGroups?: { depositKrw: number; count: number }[]
  metrics?: Record<string, number>
  walking?: WalkingRoute
}
export interface Snapshot {
  id: string; modelVersion: string; isDemo: boolean; spatialUnit: string
  createdAt: string; periodStart: string; periodEnd: string
  sources: Source[]; areas: Area[]; warnings: string[]
  calculation?: Record<string, unknown>
  availability?: DataAvailability[]
}
export interface Budget { maxDepositKrw: number; maxMonthlyRentKrw: number; leaseType?: LeaseType }
export interface LocationFilter { name: string; latitude: number; longitude: number; radiusKm: number }
export type RecommendationOrder = 'score' | 'budget-fit'
export interface Recommendation {
  area: Area; rank: number; totalScore: number; componentScores: Scores
  budgetMatchCount: number; sampleCount: number; matchRatio: number; medianRentKrw: number
  medianDepositKrw?: number
  matchedMedianDepositKrw?: number; matchedMedianRentKrw?: number
}
export interface Results {
  recommendations: Recommendation[]; effectiveWeights: Weights; warnings: string[]
  excluded: { area: Area; reason: string }[]; candidateCount: number; budget: Budget
  locationFilter?: LocationFilter
  order?: RecommendationOrder
}
