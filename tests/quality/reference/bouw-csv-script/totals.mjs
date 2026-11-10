// Totals per country from an orders CSV (ordernr;land;bedrag, decimal comma). Usage: node totals.mjs orders.csv
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Gebruik: node totals.mjs <orders.csv>');
  process.exit(1);
}
const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
const cols = head.split(';').map((c) => c.trim().toLowerCase());
const land = cols.indexOf('land');
const bedrag = cols.indexOf('bedrag');
const cents = {};
for (const row of rows) {
  const c = row.split(';');
  const key = c[land].trim();
  cents[key] = (cents[key] || 0) + Math.round(Number(c[bedrag].trim().replace(/\./g, '').replace(',', '.')) * 100);
}
console.log(JSON.stringify(Object.fromEntries(Object.entries(cents).map(([k, v]) => [k, v / 100]))));
