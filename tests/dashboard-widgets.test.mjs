import assert from 'node:assert/strict';
import test from 'node:test';

import { CUSTOM_CHART_OPTIONS } from '../src/lib/dashboard-widgets.ts';

test('custom graph builder offers a broad, unique chart catalogue', () => {
  const values = CUSTOM_CHART_OPTIONS.map((option) => option.value);
  assert.equal(values.length, 12);
  assert.equal(new Set(values).size, values.length);
  assert.deepEqual(values, [
    'bar', 'horizontal_bar', 'line', 'area', 'pie', 'radar',
    'radial', 'treemap', 'funnel', 'scatter', 'table', 'kpi',
  ]);
});
