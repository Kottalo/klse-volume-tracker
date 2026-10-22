import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { combinedChartSvg } from './stock-chart.js';

export function chartPng(models) {
  return new Resvg(combinedChartSvg(models), {
    font: {
      fontFiles: [fileURLToPath(new URL('../assets/chart-noto-sc.ttf', import.meta.url))],
      loadSystemFonts: false,
      defaultFontFamily: 'Noto Sans SC',
    },
  })
    .render()
    .asPng();
}
