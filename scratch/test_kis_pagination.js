const fs = require('fs');

async function testPaginationLogic() {
  console.log('Testing daily chart pagination logic structure...');
  const items1 = [{ stck_bsop_date: '20260701' }, { stck_bsop_date: '20260814' }]; // Ascending
  const oldestDateStr = items1[0].stck_bsop_date; // '20260701'

  const y = parseInt(oldestDateStr.slice(0, 4), 10);
  const m = parseInt(oldestDateStr.slice(4, 6), 10) - 1;
  const d = parseInt(oldestDateStr.slice(6, 8), 10);
  const oldestDate = new Date(y, m, d);
  oldestDate.setDate(oldestDate.getDate() - 1);

  const page2EndDate = oldestDate.toISOString().slice(0, 10).replace(/-/g, '');
  const page2StartDateObj = new Date(oldestDate);
  page2StartDateObj.setDate(page2StartDateObj.getDate() - 180);
  const page2StartDate = page2StartDateObj.toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`Page 1 Oldest: ${oldestDateStr} -> Page 2 Date Range: ${page2StartDate} ~ ${page2EndDate}`);
}

testPaginationLogic();
