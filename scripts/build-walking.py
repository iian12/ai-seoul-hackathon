import json
import math
from collections import Counter
from pathlib import Path
from datetime import datetime, timezone
import osmium
from walking_graph import walkable, public_entrance, distance, multi_source_paths, EdgeIndex, route_from_snap, SPEED_MPS

ROOT = Path('data/walking')
source = json.loads((ROOT / 'extract-source.json').read_text())
snapshot = json.loads(Path('public/data/seoul-snapshot.json').read_text())


class Streets(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.coordinates, self.reverse, self.edges, self.entrances, self.blocked = {}, {}, [], {}, set()
        self.rejected = Counter()

    def node(self, node):
        tags = dict(node.tags)
        if tags.get('access') in {'no', 'private'} or tags.get('foot') in {'no', 'private'} or tags.get('barrier') in {'fence', 'wall', 'block'}:
            self.blocked.add(node.id)
        if public_entrance(tags):
            if node.location.valid():
                self.entrances[node.id] = {'longitude': node.location.lon, 'latitude': node.location.lat, 'name': tags.get('name', ''), 'ref': tags.get('ref', '')}

    def way(self, way):
        tags = dict(way.tags)
        if not walkable(tags):
            return
        direction = 1 if tags.get('oneway:foot') == 'yes' else -1 if tags.get('oneway:foot') == '-1' else 0
        speed = .8 if tags.get('highway') == 'steps' else SPEED_MPS
        for a, b in zip(way.nodes, list(way.nodes)[1:]):
            if not a.location.valid() or not b.location.valid() or a.ref in self.blocked or b.ref in self.blocked:
                self.rejected['invalid_or_blocked_edges'] += 1
                continue
            pa, pb = (a.lon, a.lat), (b.lon, b.lat)
            # This service compares Seoul; pad its boundary for legitimate walking detours.
            if not (126.70 < pa[0] < 127.25 and 37.38 < pa[1] < 37.76 and 126.70 < pb[0] < 127.25 and 37.38 < pb[1] < 37.76):
                continue
            length = distance(pa, pb)
            if length <= .01:
                continue
            self.coordinates[a.ref], self.coordinates[b.ref] = pa, pb
            self.edges.append((a.ref, b.ref, length, length / speed, direction))
            if direction in {0, 1}:
                self.reverse.setdefault(b.ref, []).append((a.ref, length, length / speed))
            if direction in {0, -1}:
                self.reverse.setdefault(a.ref, []).append((b.ref, length, length / speed))


reader = osmium.io.Reader(str(ROOT / 'seoul.osm.pbf'))
header = reader.header()
print('Extract bounding box:', header.box(), flush=True)
reader.close()
streets = Streets()
streets.apply_file(str(ROOT / 'seoul.osm.pbf'), locations=True, idx='flex_mem')
districts = json.loads(Path('src/data/seoul-districts.json').read_text())


def in_ring(point, ring):
    inside = False
    j = len(ring) - 1
    for i, a in enumerate(ring):
        b = ring[j]
        if (a[1] > point[1]) != (b[1] > point[1]) and point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
        j = i
    return inside


def in_seoul(point):
    for feature in districts['features']:
        geometry = feature['geometry']
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        if any(in_ring(point, p[0]) and not any(in_ring(point, hole) for hole in p[1:]) for p in polygons):
            return True
    return False


streets.entrances = {node: item for node, item in streets.entrances.items() if in_seoul((item['longitude'], item['latitude']))}
index = EdgeIndex(streets.edges, streets.coordinates)
connected = {node: {**item, 'originalNodeId': str(node), 'destinationSnapM': 0.0} for node, item in streets.entrances.items() if node in streets.coordinates and node in streets.reverse}
edge_targets = {}
for node, entrance in streets.entrances.items():
    if node in connected:
        continue
    snap = index.snap((entrance['longitude'], entrance['latitude']))
    if snap is None or snap[0] > 20:
        continue
    offset, point, u, v, length, seconds, direction = snap
    target = -node
    streets.coordinates[target] = point
    streets.reverse[target] = []
    if direction in {0, 1}:
        partial = min(length, distance(streets.coordinates[u], point))
        streets.reverse[target].append((u, partial, partial / length * seconds))
    if direction in {0, -1}:
        partial = min(length, distance(streets.coordinates[v], point))
        streets.reverse[target].append((v, partial, partial / length * seconds))
    connected[target] = {**entrance, 'originalNodeId': str(node), 'destinationSnapM': round(offset, 1)}
    edge_targets.setdefault((u, v), []).append(target)
if not connected or len(streets.edges) < 10000:
    raise RuntimeError('Insufficient pedestrian graph or connected subway entrances')
print(f'Walk graph: {len(streets.coordinates)} nodes, {len(streets.edges)} edges, {len(connected)} connected entrances', flush=True)
distances, times, next_nodes, owners = multi_source_paths(streets.reverse, connected)
now = datetime.now(timezone.utc).isoformat()
results, statuses = {}, Counter()
for area in snapshot['areas']:
    point = (area['longitude'], area['latitude'])
    snap = index.snap(point)
    route = route_from_snap(snap, streets.coordinates, distances, times, next_nodes, owners, edge_targets)
    if route is None:
        status = 'no_nearby_walkway' if snap is None else 'no_connected_entrance'
        results[area['code']] = {'status': status, 'sourceId': 'walking-osm', 'checkedAt': now, 'origin': {'latitude': area['latitude'], 'longitude': area['longitude']}}
        statuses[status] += 1
        continue
    entrance = connected[int(route['entranceNodeId'])]
    route.update(status='ok', sourceId='walking-osm', checkedAt=now, origin={'latitude': area['latitude'], 'longitude': area['longitude']}, entranceNodeId=entrance['originalNodeId'], entranceName=entrance['name'], entranceRef=entrance['ref'], destinationSnapM=entrance['destinationSnapM'], destinationType='subway_entrance_nearby_walkway' if entrance['destinationSnapM'] else 'subway_entrance', method='local-osm-pedestrian-shortest-distance', startDefinition='법정동 대표점 인근 보행로(최대 100m 보정). 보정 직선거리는 도보 거리·시간에 포함하지 않음.', speedKmh=4.5)
    results[area['code']] = route
    statuses['ok'] += 1

report = {'createdAt': now, 'extract': source, 'graphNodes': len(streets.coordinates), 'graphEdges': len(streets.edges), 'entrancesObserved': len(streets.entrances), 'entrancesConnected': len(connected), 'entrancesDirectlyConnected': sum(1 for n in connected if n > 0), 'regions': len(results), 'statuses': dict(statuses), 'dijkstraObjective': 'shortest walking distance across mapped permitted ways to a connected subway entrance or its nearby walkway', 'timeAssumption': '4.5 km/h on ordinary paths; 0.8 m/s on stairs; no live crossing/wait-time model', 'snapPolicy': 'origin <=100m, destination <=20m. Both corrections are displayed separately and never counted as walking distance.', 'excludedWays': 'motorway/trunk/construction, access or foot forbidden/private, unresolved conditional access, cycleway without explicit foot permission', 'limitations': 'OSM completeness/access tags and entrance coverage limit results. Route runs on mapped pedestrian network; off-network endpoint corrections are not verified pedestrian links. No straight-line fallback. Not wheelchair routing.'}
if statuses['ok'] < len(snapshot['areas']) / 2:
    raise RuntimeError('Walking coverage below 50%; keep previous snapshot')
(ROOT / 'routes.tmp').write_text(json.dumps({'report': report, 'areas': results}, ensure_ascii=False))
(ROOT / 'routes.tmp').replace(ROOT / 'routes.json')
print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
