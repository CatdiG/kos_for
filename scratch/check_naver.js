const https = require('https');

function fetchBuffer(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function parseNaverCompanies(html) {
  const regex = /class="company"[^>]*>([^<]+)<\/a>/g;
  let match;
  const list = [];
  while ((match = regex.exec(html)) !== null) {
    list.push(match[1].trim());
  }
  return list;
}

async function main() {
  const decoder = new TextDecoder('euc-kr');

  const urls = [
    { label: 'sise_trans_stat', url: 'https://finance.naver.com/sise/sise_trans_stat.naver' },
    { label: 'sise_deal_rank foreign (9000)', url: 'https://finance.naver.com/sise/sise_deal_rank.naver?investor_gubun=9000' },
    { label: 'sise_deal_rank organ (1000)', url: 'https://finance.naver.com/sise/sise_deal_rank.naver?investor_gubun=1000' },
  ];

  for (const item of urls) {
    const buf = await fetchBuffer(item.url);
    const html = decoder.decode(buf);
    const tableRegex = /<table summary="([^"]+)"[\s\S]*?<\/table>/g;
    let tMatch;
    console.log(`\n================ ${item.label} ================`);
    while ((tMatch = tableRegex.exec(html)) !== null) {
      const summary = tMatch[1];
      const companies = parseNaverCompanies(tMatch[0]);
      if (companies.length > 0) {
        console.log(`Table: [${summary}]`);
        companies.slice(0, 5).forEach((name, i) => console.log(`  ${i+1}. ${name}`));
      }
    }
  }
}

main();
