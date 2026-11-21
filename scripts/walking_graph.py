"""A small pedestrian graph. Distances are along mapped ways, never a straight-line multiplier."""
import heapq
import math

SPEED_MPS = 4.5 / 3.6
MAX_SNAP_M = 100.0
FORBIDDEN_HIGHWAYS = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'raceway'}
ALLOW_FOOT = {'yes', 'designated', 'permissive', 'official'}


def public_entrance(tags):
    return tags.get('railway') == 'subway_entrance' and tags.get('access') not in {'no', 'private', 'customers'} and tags.get('foot') not in {'no', 'private'} and tags.get('entrance') != 'exit'


def walkable(tags):
    highway = tags.get('highway', '')
    if not highway or highway in FORBIDDEN_HIGHWAYS or tags.get('area') == 'yes':
        return False
    if tags.get('foot') in {'no', 'private', 'use_sidepath'}:
        return False
    if tags.get('access') in {'no', 'private', 'customers', 'delivery', 'permit'} and tags.get('foot') not in ALLOW_FOOT:
        return False
    if tags.get('foot:conditional') or tags.get('access:conditional'):
        return False  # No operating-hours inference in this snapshot.
    if highway in {'cycleway', 'bridleway'} and tags.get('foot') not in ALLOW_FOOT:
        return False
    return True


def distance(a, b):
    """(longitude, latitude) WGS84 distance in metres."""
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dy, dx = lat2 - lat1, math.radians(b[0] - a[0])
    h = math.sin(dy / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dx / 2) ** 2
    return 6371000 * 2 * math.atan2(math.sqrt(h), math.sqrt(max(0, 1 - h)))


def multi_source_paths(reverse_graph, destinations):
    """Dijkstra on reversed edges: optimal walking distance TO any connected entrance."""
    distances, times, next_nodes, owners = {}, {}, {}, {}
    queue = []
    for node in sorted(destinations):
        distances[node], times[node], owners[node] = 0.0, 0.0, node
        heapq.heappush(queue, (0.0, node))
    while queue:
        cost, node = heapq.heappop(queue)
        if cost != distances.get(node):
            continue
        for previous, metres, seconds in reverse_graph.get(node, []):
            candidate = cost + metres
            if candidate < distances.get(previous, math.inf):
                distances[previous] = candidate
                times[previous] = times[node] + seconds
                next_nodes[previous] = node
                owners[previous] = owners[node]
                heapq.heappush(queue, (candidate, previous))
    return distances, times, next_nodes, owners


def projection(point, a, b):
    # Local planar projection is used only to snap onto a mapped edge, never to calculate the route.
    kx, ky = math.cos(math.radians(point[1])) * 111195, 111195
    ax, ay = (a[0] - point[0]) * kx, (a[1] - point[1]) * ky
    bx, by = (b[0] - point[0]) * kx, (b[1] - point[1]) * ky
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx * dx + dy * dy else 0.0
    snapped = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return snapped, distance(point, snapped)


class EdgeIndex:
    def __init__(self, edges, coordinates):
        self.edges, self.coordinates, self.cells = edges, coordinates, {}
        self.cell_size = 0.002
        for index, (u, v, _, _, _) in enumerate(edges):
            a, b = coordinates[u], coordinates[v]
            for x in range(math.floor(min(a[0], b[0]) / self.cell_size), math.floor(max(a[0], b[0]) / self.cell_size) + 1):
                for y in range(math.floor(min(a[1], b[1]) / self.cell_size), math.floor(max(a[1], b[1]) / self.cell_size) + 1):
                    self.cells.setdefault((x, y), []).append(index)

    def snap(self, point):
        x, y = math.floor(point[0] / self.cell_size), math.floor(point[1] / self.cell_size)
        candidates = set()
        for dx in [-1, 0, 1]:
            for dy in [-1, 0, 1]:
                candidates.update(self.cells.get((x + dx, y + dy), []))
        best = None
        for i in sorted(candidates):
            u, v, length, seconds, direction = self.edges[i]
            snapped, offset = projection(point, self.coordinates[u], self.coordinates[v])
            if best is None or offset < best[0]:
                best = (offset, snapped, u, v, length, seconds, direction)
        return best if best and best[0] <= MAX_SNAP_M else None


def route_from_snap(snap, coordinates, distances, times, next_nodes, owners, edge_targets=None):
    if snap is None:
        return None
    offset, point, u, v, length, seconds, direction = snap
    options = []
    # A destination projected onto this very edge may be reached without walking via an endpoint.
    for target in (edge_targets or {}).get((u, v), []):
        start_position = distance(coordinates[u], point)
        target_position = distance(coordinates[u], coordinates[target])
        if direction == 1 and target_position < start_position or direction == -1 and target_position > start_position:
            continue
        partial = distance(point, coordinates[target])
        options.append((partial, partial / length * seconds, target))
    if direction in {0, -1} and u in distances:
        partial = min(length, distance(point, coordinates[u]))
        options.append((partial + distances[u], partial / length * seconds + times[u], u))
    if direction in {0, 1} and v in distances:
        partial = min(length, distance(point, coordinates[v]))
        options.append((partial + distances[v], partial / length * seconds + times[v], v))
    if not options:
        return None
    metres, seconds, node = min(options)
    geometry, start, visited = [list(point), list(coordinates[node])], node, set()
    while node in next_nodes:
        if node in visited:
            raise ValueError('Cycle in shortest-path tree')
        visited.add(node)
        node = next_nodes[node]
        geometry.append(list(coordinates[node]))
    if len(geometry) < 2:
        return None
    return dict(distanceM=round(metres, 1), durationSeconds=round(seconds, 1), originSnapM=round(offset, 1), entranceNodeId=str(owners[start]), geometry={'type': 'LineString', 'coordinates': geometry})
