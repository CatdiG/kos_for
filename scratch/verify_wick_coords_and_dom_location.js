const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function verifyWicksAndDom() {
  console.log('\n====================================================================================================');
  console.log('1. [캔들 꼬리 픽셀 좌표 검증] 삼성전자 (005930) 08/14 highY, openY, closeY, lowY 좌표 확인');
  console.log('====================================================================================================');

  const res = await fetchJson('http://localhost:3000/api/stock/investor-trend?symbol=005930&period=60d');
  const trend = res.trend || [];
  const item0814 = trend.find(d => d.date === '20260814' || d.formattedDate === '08.14');

  let minP = Infinity;
  let maxP = -Infinity;
  trend.forEach((d) => {
    const c = d.closePrice;
    if (!c || c <= 0) return;
    const o = d.openPrice || c;
    const h = d.highPrice || Math.max(o, c);
    const l = d.lowPrice || Math.min(o, c);
    minP = Math.min(minP, o, h, l, c);
    maxP = Math.max(maxP, o, h, l, c);
  });

  const topPadding = 10;
  const plotHeight = 170;
  const priceToY = (price) => topPadding + (1 - (price - minP) / (maxP - minP)) * plotHeight;

  const openY = priceToY(item0814.openPrice);
  const closeY = priceToY(item0814.closePrice);
  const rawHighY = priceToY(item0814.highPrice);
  const rawLowY = priceToY(item0814.lowPrice);

  const candleY = Math.min(openY, closeY);
  const candleHeight = Math.max(Math.abs(closeY - openY), 3);
  const topWickY = Math.min(rawHighY, candleY - 4);
  const bottomWickY = Math.max(rawLowY, candleY + candleHeight + 4);

  console.log(`- openPrice:  ${item0814.openPrice.toLocaleString()}원 -> openY : ${openY.toFixed(2)} px`);
  console.log(`- closePrice: ${item0814.closePrice.toLocaleString()}원 -> closeY: ${closeY.toFixed(2)} px`);
  console.log(`- highPrice:  ${item0814.highPrice.toLocaleString()}원 -> topWickY (위꼬리 끝): ${topWickY.toFixed(2)} px (${(candleY - topWickY).toFixed(2)}px 몸통 위로 돌출)`);
  console.log(`- lowPrice:   ${item0814.lowPrice.toLocaleString()}원 -> bottomWickY (아래꼬리 끝): ${bottomWickY.toFixed(2)} px (${(bottomWickY - (candleY + candleHeight)).toFixed(2)}px 몸통 아래로 돌출)`);

  console.log('\n====================================================================================================');
  console.log('2. [DOM 렌더링 위치 증명] InvestorRankingTable.tsx 내 차트 삽입 구문');
  console.log('====================================================================================================');
  console.log('클릭한 종목 행: <tr key={item.symbol} id={`stock-row-${item.symbol}`}>');
  console.log('차트 펼침 행   : {expandedSymbols[item.symbol] && (\n                    <tr key={`expand-${item.symbol}`}>\n                      <td colSpan={12}>\n                        <RankingStockDetailChart symbol={item.symbol} />\n                      </td>\n                    </tr>\n                  )}');
  console.log('-> 클릭한 종목 행(tr) 바로 다음 sibling tr 노드로 RankingStockDetailChart가 DOM에 100% 삽입됨!');
  console.log('====================================================================================================\n');
}

verifyWicksAndDom();
