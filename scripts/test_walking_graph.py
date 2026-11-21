import unittest
from walking_graph import walkable, public_entrance, distance, multi_source_paths, EdgeIndex, route_from_snap


class WalkingGraphTests(unittest.TestCase):
    def test_access_restrictions_and_vehicle_oneway(self):
        self.assertFalse(walkable({'highway': 'motorway'}))
        self.assertFalse(walkable({'highway': 'service', 'access': 'private'}))
        self.assertFalse(walkable({'highway': 'footway', 'foot': 'no'}))
        self.assertFalse(walkable({'highway': 'cycleway'}))
        self.assertFalse(walkable({'highway': 'footway', 'foot:conditional': 'yes @ night'}))
        self.assertTrue(walkable({'highway': 'cycleway', 'foot': 'yes'}))
        self.assertTrue(walkable({'highway': 'residential', 'oneway': 'yes'}))
        self.assertFalse(public_entrance({'railway': 'subway_entrance', 'foot': 'private'}))
        self.assertFalse(public_entrance({'railway': 'subway_entrance', 'entrance': 'exit'}))
        self.assertTrue(public_entrance({'railway': 'subway_entrance'}))

    def test_network_detour_is_not_replaced_by_straight_line(self):
        coords = {1: (0, 0), 2: (.001, 0), 3: (.001, .001)}
        a, b = distance(coords[1], coords[2]), distance(coords[2], coords[3])
        graph = {2: [(1, a, a)], 3: [(2, b, b)]}
        distances, times, parents, owners = multi_source_paths(graph, {3: {}})
        self.assertAlmostEqual(distances[1], a + b)
        self.assertGreater(distances[1], distance(coords[1], coords[3]) * 1.3)
        index = EdgeIndex([(1, 2, a, a, 1)], coords)
        result = route_from_snap(index.snap((0, 0)), coords, distances, times, parents, owners)
        self.assertAlmostEqual(result['distanceM'], round(a + b, 1))
        self.assertEqual(result['geometry']['coordinates'][-1], list(coords[3]))

    def test_foot_oneway_cannot_be_traversed_backward(self):
        coords = {1: (0, 0), 2: (.001, 0)}
        length = distance(coords[1], coords[2])
        index = EdgeIndex([(1, 2, length, length, 1)], coords)
        d, t, n, o = multi_source_paths({2: [(1, length, length)]}, {1: {}})
        self.assertIsNone(route_from_snap(index.snap((.0005, 0)), coords, d, t, n, o))

    def test_source_correction_is_reported_but_not_added_as_a_walk(self):
        coords = {1: (0, 0), 2: (.001, 0)}
        length = distance(coords[1], coords[2])
        index = EdgeIndex([(1, 2, length, length, 0)], coords)
        d, t, n, o = multi_source_paths({2: [(1, length, length)], 1: [(2, length, length)]}, {2: {}})
        result = route_from_snap(index.snap((.0005, .0002)), coords, d, t, n, o)
        self.assertGreater(result['originSnapM'], 20)
        self.assertAlmostEqual(result['distanceM'], round(length / 2, 1))
        self.assertIsNone(index.snap((1, 1)))

    def test_destination_on_same_edge_does_not_force_endpoint_detour(self):
        coords = {1: (0, 0), 2: (.001, 0), -3: (.0006, 0)}
        length = distance(coords[1], coords[2])
        index = EdgeIndex([(1, 2, length, length, 0)], coords)
        d, t, n, o = multi_source_paths({-3: [(1, length * .6, length * .6), (2, length * .4, length * .4)]}, {-3: {}})
        result = route_from_snap(index.snap((.0005, 0)), coords, d, t, n, o, {(1, 2): [-3]})
        self.assertAlmostEqual(result['distanceM'], round(length * .1, 1))


if __name__ == '__main__':
    unittest.main()
