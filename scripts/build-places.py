"""Build an offline place-name/address index from the existing Seoul OSM extract."""
import json
from pathlib import Path
import osmium

root = Path('data/walking')
rows = []


class Places(osmium.SimpleHandler):
    def save(self, obj, lon, lat, kind):
        tags = dict(obj.tags)
        name = tags.get('name:ko') or tags.get('name')
        street = tags.get('addr:street', '')
        number = tags.get('addr:housenumber', '')
        address = ' '.join(filter(None, [tags.get('addr:city'), tags.get('addr:suburb'), street, number]))
        if not name and not (street and number):
            return
        if not (126.75 < lon < 127.20 and 37.42 < lat < 37.71):
            return
        if not (tags.get('building') or tags.get('office') or tags.get('amenity') in {'school', 'university', 'college', 'kindergarten', 'townhall', 'library', 'hospital'} or tags.get('railway') == 'station' or street):
            return
        category = '학교' if tags.get('amenity') in {'school', 'university', 'college', 'kindergarten'} else '직장·건물' if tags.get('office') or tags.get('building') else '장소'
        rows.append({'id': f'{kind}{obj.id}', 'name': name or address, 'address': address, 'category': category, 'latitude': round(lat, 7), 'longitude': round(lon, 7)})

    def node(self, node):
        if node.location.valid():
            self.save(node, node.location.lon, node.location.lat, 'n')

    def way(self, way):
        if not way.tags.get('name') and not way.tags.get('name:ko') and not way.tags.get('addr:street'):
            return
        points = [(n.lon, n.lat) for n in way.nodes if n.location.valid()]
        if points:
            self.save(way, (min(p[0] for p in points) + max(p[0] for p in points)) / 2, (min(p[1] for p in points) + max(p[1] for p in points)) / 2, 'w')

    def area(self, area):
        # University campuses are often multipolygon relations, not individual buildings.
        if area.from_way() or not (area.tags.get('name') or area.tags.get('name:ko')):
            return
        points = [(n.lon, n.lat) for ring in area.outer_rings() for n in ring if n.location.valid()]
        if points:
            self.save(area, (min(p[0] for p in points) + max(p[0] for p in points)) / 2, (min(p[1] for p in points) + max(p[1] for p in points)) / 2, 'a')


Places().apply_file(str(root / 'seoul.osm.pbf'), locations=True, idx='flex_mem')
source = json.loads((root / 'extract-source.json').read_text())
target = Path('public/data/seoul-places.json')
temporary = target.with_suffix('.json.tmp')
temporary.write_text(json.dumps({'source': 'OpenStreetMap contributors / BBBike, ODbL', 'url': 'https://download.bbbike.org/osm/bbbike/Seoul/', 'extractLastModified': source.get('lastModified'), 'places': rows}, ensure_ascii=False, separators=(',', ':')))
temporary.replace(target)
print(f'{target}: {len(rows)} indexed places, {target.stat().st_size:,} bytes')
