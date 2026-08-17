export const CUSTOM_CHART_OPTIONS = [
  { value: 'bar', label: 'Vertical bars' },
  { value: 'horizontal_bar', label: 'Horizontal bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Donut' },
  { value: 'radar', label: 'Radar' },
  { value: 'radial', label: 'Radial bars' },
  { value: 'treemap', label: 'Treemap' },
  { value: 'funnel', label: 'Funnel' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'table', label: 'Table' },
  { value: 'kpi', label: 'KPI number' },
] as const;

export type CustomChartType = (typeof CUSTOM_CHART_OPTIONS)[number]['value'];
