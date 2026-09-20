// Minimal CSV: quoted fields, doubled quotes, embedded newlines, CRLF/LF/CR, and comma/semicolon/tab delimiters.

export function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

export function parseCsv(text, delimiter = detectDelimiter(text)) {
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delimiter) endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

// A cell starting with these can run as a formula when the file is opened in a spreadsheet.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return '';
  const isNumber = typeof value === 'number';
  if (isNumber && !Number.isFinite(value)) return '';
  let s = String(value);
  if (!isNumber && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export const toCsv = (rows) => `${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
