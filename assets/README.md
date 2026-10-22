# Chart font

`chart-noto-sc.ttf` is a static weight-500 subset of Noto Sans SC, distributed
under the SIL Open Font License in `OFL.txt`. It contains the ASCII and fixed
Chinese chart labels from `lib/stock-chart.js`, keeping Linux/Render PNGs legible
without depending on installed fonts. Company names are not rendered in images;
stock codes identify the charts.

Upstream: https://github.com/google/fonts/tree/main/ofl/notosanssc

If chart labels change, regenerate the subset with FontTools (`varLib.instancer`
at weight 500, then `subset` with the chart source text plus ASCII 32–126).
