import fs from 'fs';
import path from 'path';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Gebruik: node totals.mjs <pad-naar-csv>');
  process.exit(1);
}

const fileContent = fs.readFileSync(filePath, 'utf-8');
const lines = fileContent.trim().split('\n');

if (lines.length < 2) {
  console.error('Error: CSV file is empty or has only one line.');
  process.exit(1);
}

// Parse header
const header = lines[0].split(',').map(h => h.trim());

// Find column indices for 'Land' and 'Bedrag' (case-insensitive matching)
const landIndex = header.findIndex(h => h.toLowerCase() === 'land');
const bedragIndex = header.findIndex(h => h.toLowerCase() === 'bedrag');

if (landIndex === -1 || bedragIndex === -1) {
  console.error('Error: Could not find "Land" and "Bedrag" columns in the header.');
  process.exit(1);
}

const totals = {};

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  const values = line.split(',').map(v => v.trim());

  if (values.length <= landIndex || values.length <= bedragIndex) {
    continue;
  }

  const land = values[landIndex];
  const bedrag = parseFloat(values[bedragIndex]);

  if (land && !isNaN(bedrag)) {
    if (totals[land]) {
      totals[land] += bedrag;
    } else {
      totals[land] = bedrag;
    }
  }
}

// Round to 2 decimals
const roundedTotals = {};
for (const key in totals) {
  roundedTotals[key] = Math.round(totals[key] * 100) / 100;
}

console.log(JSON.stringify(roundedTotals));
