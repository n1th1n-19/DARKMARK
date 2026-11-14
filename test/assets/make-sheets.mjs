// Generates the sheet viewer test files. Run from the repo root: node test/assets/make-sheets.mjs
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const regions = ['North', 'South', 'East', 'West'];
const products = ['Widget', 'Gadget, large', 'Sprocket', 'Gizmo "pro"', 'Doohickey'];

// sample.xlsx: Sales (mixed types, one empty cell) + Notes
const sales = [['Order', 'Region', 'Product', 'Qty', 'Unit price', 'Ordered', 'Shipped at', 'Paid']];
for (let i = 1; i <= 30; i++) {
  sales.push([
    1000 + i,
    regions[i % 4],
    products[i % 5],
    (i * 7) % 23 + 1,
    Math.round(((i * 13.37) % 90 + 5) * 100) / 100,
    new Date(2024, i % 12, (i % 27) + 1),
    new Date(2024, i % 12, (i % 27) + 2, 9 + (i % 8), (i * 11) % 60),
    i % 3 !== 0,
  ]);
}
sales[5][3] = null; // empty cell
const ws = XLSX.utils.aoa_to_sheet(sales, { cellDates: true });
ws['!cols'] = [{ wch: 8 }, { wch: 10 }, { wch: 18 }, { wch: 6 }, { wch: 11 }, { wch: 12 }, { wch: 18 }, { wch: 7 }];
const notes = XLSX.utils.aoa_to_sheet([
  ['Note'],
  ['Quarterly numbers are preliminary.'],
  ['Prices are in EUR, excluding VAT.'],
  ['A very long note that should be truncated with an ellipsis in the grid, the full text shows in the tooltip when you hover the cell.'],
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sales');
XLSX.utils.book_append_sheet(wb, notes, 'Notes');
writeFileSync(dir + 'sample.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

// sample.csv: quoted fields with commas and quotes, numbers, dates
const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csv = ['id,name,city,amount,date'];
for (let i = 1; i <= 20; i++) {
  csv.push([i, q(`Customer ${i}, Ltd`), q(i % 2 ? 'Berlin' : 'Paris, FR'), (i * 12.5).toFixed(2), `2024-${String((i % 12) + 1).padStart(2, '0')}-15`].join(','));
}
writeFileSync(dir + 'sample.csv', csv.join('\n') + '\n');

// big.csv: header + 50,000 rows x 8 columns
const big = ['id,name,city,amount,qty,date,active,code'];
const cities = ['Berlin', 'Paris', 'Rome', 'Oslo', 'Madrid', 'Lisbon', 'Vienna', 'Prague'];
for (let i = 1; i <= 50000; i++) {
  big.push(`${i},user${i},${cities[i % 8]},${((i * 37) % 10000 / 100).toFixed(2)},${i % 97},2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')},${i % 2 ? 'TRUE' : 'FALSE'},C${(i * 7919) % 100000}`);
}
writeFileSync(dir + 'big.csv', big.join('\n') + '\n');
