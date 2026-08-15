const fs = require('fs');

async function getNaverRanking() {
  // sosok=0 (KOSPI), investor_gubun=9000 (외국인)
  const url = 'https://finance.naver.com/sise/sise_deal_rank.naver?sosok=0&investor_gubun=9000';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  const buffer = await res.arrayBuffer();
  const decoder = new TextDecoder('euc-kr');
  const html = decoder.decode(buffer);

  // Extract table rows from html
  // Look for종목명, 순매수 대금/수량
  const items = [];
  // Match stock links and values in table
  const regex = /<a href="\/item\/main\.naver\?code=(\d+)" class="tlt">(.*?)<\/a>[\s\S]*?<td class="number">(.*?)<\/td>[\s\S]*?<td class="number">(.*?)<\/td>/g;
  
  let match;
  while ((match = regex.exec(html)) !== null && items.length < 10) {
    items.push({
      symbol: match[1],
      name: match[2].trim(),
      val1: match[3].replace(/<[^>]+>/g, '').trim(),
      val2: match[4].replace(/<[^>]+>/g, '').trim()
    });
  }

  console.log('--- Naver Finance Foreigner Net Buy Top 10 Raw Extracted ---');
  console.log(JSON.stringify(items, null, 2));

  // If regex missed table parsing, write HTML snippet to check structure
  if (items.length === 0) {
    fs.writeFileSync('scratch/naver_page.html', html);
    console.log('Saved html to scratch/naver_page.html');
  }
}

getNaverRanking();
