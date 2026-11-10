const fs = require("fs");
const path = require("path");

const file = process.argv[2];

if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const csv = fs.readFileSync(file, "utf-8");

const totals = {};

const lines = csv.trim().split("\n");

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (line === "") continue;

  // splits op puntkomma (semitone-comma separator)
  const parts = line.split(";");
  if (parts.length < 3) continue;

  // strip whitespace from string fields
  const land = parts[1].trim();
  let bedrag = parts[2].trim();

  // replace comma decimal separator with point
  bedrag = bedrag.replace(",", ".");

  if (!totals[land]) {
    totals[land] = 0;
  }
  totals[land] += parseFloat(bedrag) || 0;
}

// Round to 2 decimals
const rounded = {};
for (const key of Object.keys(totals)) {
  rounded[key] = Math.round(totals[key] * 100) / 100;
}

console.log(JSON.stringify(rounded));
