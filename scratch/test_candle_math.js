const displayTrend = [
  { formattedDate: '08.10', openPrice: 1443000, highPrice: 1487000, lowPrice: 1397000, closePrice: 1420000 },
  { formattedDate: '08.11', openPrice: 1405000, highPrice: 1455000, lowPrice: 1373000, closePrice: 1425000 },
  { formattedDate: '08.12', openPrice: 1456000, highPrice: 1549000, lowPrice: 1440000, closePrice: 1504000 },
  { formattedDate: '08.13', openPrice: 1582000, highPrice: 1634000, lowPrice: 1567000, closePrice: 1593000 },
  { formattedDate: '08.14', openPrice: 1695000, highPrice: 1697000, lowPrice: 1626000, closePrice: 1657000 },
];

let min = Infinity;
let max = -Infinity;
displayTrend.forEach((d) => {
  min = Math.min(min, d.openPrice, d.highPrice, d.lowPrice, d.closePrice);
  max = Math.max(max, d.openPrice, d.highPrice, d.lowPrice, d.closePrice);
});

const pad = (max - min) * 0.05;
const minPrice = Math.floor(min - pad);
const maxPrice = Math.ceil(max + pad);

const topPadding = 10;
const chartHeight = 200; // SVG Y height

const priceToY = (price) => {
  return topPadding + (1 - (price - minPrice) / (maxPrice - minPrice)) * chartHeight;
};

console.log(`=== Candlestick Domain & Pixel Y Mapping Verification ===`);
console.log(`minPrice: ${minPrice.toLocaleString()}원, maxPrice: ${maxPrice.toLocaleString()}원`);
console.log(`Price Range: ${(maxPrice - minPrice).toLocaleString()}원, Canvas Height: ${chartHeight}px\n`);

displayTrend.forEach((d) => {
  const openY = priceToY(d.openPrice);
  const highY = priceToY(d.highPrice);
  const lowY = priceToY(d.lowPrice);
  const closeY = priceToY(d.closePrice);

  const candleY = Math.min(openY, closeY);
  const candleHeight = Math.abs(closeY - openY);
  const wickHeight = lowY - highY;

  console.log(`[Item ${d.formattedDate}]`);
  console.log(`  Prices: Open=${d.openPrice.toLocaleString()}, High=${d.highPrice.toLocaleString()}, Low=${d.lowPrice.toLocaleString()}, Close=${d.closePrice.toLocaleString()}`);
  console.log(`  SVG Y Coordinates: HighY=${highY.toFixed(1)}px, OpenY=${openY.toFixed(1)}px, CloseY=${closeY.toFixed(1)}px, LowY=${lowY.toFixed(1)}px`);
  console.log(`  Candle Body Y=${candleY.toFixed(1)}px, Body Height=${candleHeight.toFixed(1)}px, Total Wick Line Height=${wickHeight.toFixed(1)}px\n`);
});
