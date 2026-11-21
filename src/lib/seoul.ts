import districts from '../data/seoul-districts.json' with { type: 'json' }

export const seoulDistricts = districts as unknown as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>
export const SEOUL_DISTRICTS = new Set(seoulDistricts.features.map(f => String(f.properties?.SIG_KOR_NM)))
type Point = number[]
function inRing(point: Point, ring: Point[]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    // Include points on the boundary.
    const cross = (point[0] - xi) * (yj - yi) - (point[1] - yi) * (xj - xi)
    if (Math.abs(cross) < 1e-10 && point[0] >= Math.min(xi, xj) && point[0] <= Math.max(xi, xj) && point[1] >= Math.min(yi, yj) && point[1] <= Math.max(yi, yj)) return true
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function inPolygon(point: Point, rings: Point[][]) { return inRing(point, rings[0]) && !rings.slice(1).some(r => inRing(point, r)) }
export function isInSeoul(latitude: number, longitude: number) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false
  return seoulDistricts.features.some(f => f.geometry.type === 'Polygon' ? inPolygon([longitude, latitude], f.geometry.coordinates) : f.geometry.coordinates.some(p => inPolygon([longitude, latitude], p)))
}
