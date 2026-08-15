const fs = require('fs');

// Test date difference calculation
const today = new Date();
const firstDateStr = '20260703'; // Example oldest date in 30-item array
const year = parseInt(firstDateStr.slice(0, 4), 10);
const month = parseInt(firstDateStr.slice(4, 6), 10) - 1;
const day = parseInt(firstDateStr.slice(6, 8), 10);
const firstDate = new Date(year, month, day);

const diffDays = Math.round((today.getTime() - firstDate.getTime()) / (1000 * 3600 * 24));
console.log(`Diff calendar days between ${firstDateStr} and today (${today.toISOString().slice(0,10)}): ${diffDays} days`);
console.log(`Is genuinely new listing (<90 calendar days)? ${diffDays < 90}`);
