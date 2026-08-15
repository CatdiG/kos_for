const fs = require('fs');

const today = new Date();
const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
const startDateObj = new Date(today);
startDateObj.setDate(startDateObj.getDate() - 365); // 1 full year ago (~250 trading days)
const startDate = startDateObj.toISOString().slice(0, 10).replace(/-/g, '');

console.log(`startDate (1 year ago): ${startDate}, endDate: ${endDate}`);
