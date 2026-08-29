import assert from 'node:assert/strict';
import test from 'node:test';

import {
  availableBreakdownModes,
  geoPointFor,
  selectBreakdownView,
} from '../src/lib/dashboard-breakdown.ts';

test('selects the clearest breakdown view for the category count', () => {
  assert.equal(selectBreakdownView([]), 'empty');
  assert.equal(selectBreakdownView([10]), 'table');
  assert.equal(selectBreakdownView([10, 8]), 'donut');
  assert.equal(selectBreakdownView([10, 8, 6, 4, 2]), 'donut');
  assert.equal(selectBreakdownView([10, 8, 6, 4, 2, 1]), 'treemap');
  assert.equal(selectBreakdownView(Array.from({ length: 12 }, (_, index) => index + 1)), 'treemap');
  assert.equal(selectBreakdownView(Array.from({ length: 13 }, (_, index) => index + 1)), 'table');
});

test('uses a table when part-to-whole geometry would misrepresent the values', () => {
  assert.equal(selectBreakdownView([10, -2, 4]), 'table');
  assert.equal(selectBreakdownView([0, 0, 0]), 'table');
});

test('offers a broad chart set and only offers a map for real geographic labels', () => {
  assert.deepEqual(
    availableBreakdownModes('category', ['Laptop', 'Monitor']),
    ['auto', 'donut', 'treemap', 'bubble', 'radial', 'waffle', 'table', 'kpi'],
  );
  assert.deepEqual(
    availableBreakdownModes('geographic', ['Maharashtra', 'Gujarat']),
    ['auto', 'map', 'donut', 'treemap', 'bubble', 'radial', 'waffle', 'table', 'kpi'],
  );
  assert.equal(availableBreakdownModes('category', ['Maharashtra', 'Gujarat']).includes('map'), true);
  assert.equal(availableBreakdownModes('geographic', ['Unknown place']).includes('map'), false);
});

test('recognises the locations used by the sales dashboard', () => {
  assert.deepEqual(geoPointFor('Maharashtra'), { latitude: 19.75, longitude: 75.71 });
  assert.deepEqual(geoPointFor('New Delhi'), { latitude: 28.61, longitude: 77.21 });
  assert.equal(geoPointFor('Not set'), null);
});
