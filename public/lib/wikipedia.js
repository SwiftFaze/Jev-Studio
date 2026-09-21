// Pure helpers for the Wikipedia answer page: no DOM, no network. The server (src/wikipedia.js) uses the text helpers to
// turn Wikipedia's replies into plain text, and the page uses the question builders and readers to talk to Jev.
//
// Jev never writes the answer. Code builds a list of candidates at each step and Jev picks one, so the answer is always
// text that is really on the page.

export const WIKI_ORIGIN = 'https://en.wikipedia.org';
export const MAX_OPTION_CHARS = 400; // a candidate is cut to this
export const SNIPPET_OPTION_CHARS = 300;
export const MAX_CHOICES = 250; // the API allows 255 options in a Choice; this leaves room for `none` and a spare
export const MAX_CHUNKS = 4; // a part is cut into at most this many Choices in one request (1,000 candidates)
export const MAX_TERMS = 10;
export const MAX_RESULTS = 12; // articles Jev picks from at step 2

const clip = (text, max = MAX_OPTION_CHARS) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/* ---------- links ---------- */

// encodeURIComponent, but leaving the characters Wikipedia leaves readable in its own addresses.
const readable = (encoded) => encoded.replace(/%(?:28|29|2C|3A|27)/gi, (m) => decodeURIComponent(m));

/** The address of an article, or of one heading in it. Always on the one fixed host, whatever the title says. */
export function articleUrl(title, anchor = '') {
  const page = readable(encodeURIComponent(String(title).trim().replace(/\s+/g, '_')));
  return `${WIKI_ORIGIN}/wiki/${page}${anchor ? `#${readable(encodeURIComponent(anchor))}` : ''}`;
}

/* ---------- step 1: search terms ---------- */

const QUESTION_WORDS = new Set(['what', "what's", 'whats', 'who', "who's", 'whom', 'whose', 'when', 'where', 'which', 'why', 'how']);
const STOPWORDS = new Set(
  ('a an the is are was were be been being am do does did done has have had can could will would shall should may might must ' +
    'of in on at to for from by with about as into than then that this these those it its it\'s there their they them he she his her ' +
    'and or not tell me please give many much long old big large tall high far small wide deep ' +
    'i you we us our your my').split(/\s+/),
);
// Lower-case words that can sit inside a name: "Lord of the Rings", "Ludwig van Beethoven".
const CONNECTORS = new Set(['of', 'the', 'de', 'la', 'le', 'van', 'von', 'der', 'and', 'in', 'on', 'for', 'du', 'del', 'da']);

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const bare = (word) => word.replace(/['’]s$/i, '').replace(/^[-'’]+|[-'’]+$/g, '');

/**
 * The searches worth trying for a question, best guesses first, at most ten and no two alike: the question as typed, the
 * question without its question words and filler, each run of content words, and each run of capitalised words (names).
 * Wikipedia's own ranking is noisy for a whole question ("how big is paris" finds an album first), so Jev picks the term.
 */
export function searchTerms(question) {
  const typed = squash(String(question ?? ''));
  if (!typed) return [];

  const words = (typed.match(WORD) ?? []).map((raw) => ({ raw: bare(raw), lower: bare(raw).toLowerCase() })).filter((w) => w.raw);
  const filler = (w) => QUESTION_WORDS.has(w.lower) || STOPWORDS.has(w.lower);

  const content = [];
  let run = [];
  for (const w of words) {
    if (filler(w)) {
      if (run.length) content.push(run);
      run = [];
    } else run.push(w.raw);
  }
  if (run.length) content.push(run);

  const names = [];
  run = [];
  let pending = []; // lower-case connectors seen since the last capitalised word: kept only if another capital follows
  const closeRun = () => {
    if (run.length) names.push(run);
    run = [];
    pending = [];
  };
  for (const w of words) {
    const capital = /^\p{Lu}/u.test(w.raw);
    if (capital && !filler(w)) {
      run.push(...pending, w.raw);
      pending = [];
    } else if (run.length && CONNECTORS.has(w.lower)) pending.push(w.raw);
    else closeRun();
  }
  closeRun();

  const candidates = [typed, content.flat().join(' '), ...content.map((r) => r.join(' ')), ...names.map((r) => r.join(' '))];
  const seen = new Set();
  const terms = [];
  for (const term of candidates) {
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.slice(0, MAX_TERMS);
}

/* ---------- text out of Wikipedia's replies ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', minus: '−', hellip: '…', times: '×', deg: '°', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•' };

/** `&amp;`, `&#160;` and `&#x27;` to the characters they stand for. Anything unknown is left as it is. */
export function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (whole, dec, hex, name) => {
    if (name) return ENTITIES[name] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// Footnote marks and editors' notes that have crept into the text: [3], [a], [update], [citation needed].
const NOTE_MARK = /\[(?:\d{1,3}|[a-z]|update|citation needed|clarification needed|when\?|who\?|according to whom\?|note \d+|nb \d+)\]/gi;
// Taking a mark out can leave a space before the punctuation that followed it (`km2 [update].`), so that is closed up too.
export const stripNoteMarks = (text) => text.replace(NOTE_MARK, '').replace(/\s+([.,;:!?])/g, '$1');

/** A search snippet: Wikipedia wraps the matched words in `<span class="searchmatch">`. Text only comes out. */
export function stripSnippet(html) {
  return squash(stripNoteMarks(decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ''))));
}

/* ---------- the article's text: headings and sentences ---------- */

const SKIPPED_SECTIONS = new Set(['references', 'external links', 'further reading', 'see also', 'notes', 'bibliography', 'sources', 'citations', 'footnotes']);
/** A heading's anchor on the page: its text with the spaces made underscores. */
export const anchorOf = (heading) => heading.trim().replace(/\s+/g, '_');

/**
 * Cut a plain-text extract (headings look like `== Geography ==`, and `=== Climate ===` inside it) into its sections. The
 * text before the first heading is the lead. Each section has its `path` ("Geography › Climate"), the `anchor` of its own
 * heading, and only its own text, not its subsections'. A section with no text of its own is left out.
 */
export function splitSections(extract) {
  const sections = [];
  const above = []; // the headings above the current one
  let current = { path: 'Lead', title: 'Lead', anchor: '', level: 1, lines: [] };
  const finish = () => {
    const text = current.lines.join('\n').trim();
    if (text && !SKIPPED_SECTIONS.has(current.title.toLowerCase())) sections.push({ path: current.path, title: current.title, anchor: current.anchor, level: current.level, text });
  };
  for (const line of String(extract ?? '').split(/\r?\n/)) {
    const heading = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    finish();
    const level = heading[1].length;
    const title = heading[2];
    while (above.length && above.at(-1).level >= level) above.pop();
    above.push({ level, title });
    current = { path: above.map((h) => h.title).join(' › '), title, anchor: anchorOf(title), level, lines: [] };
  }
  finish();
  return sections;
}

// A full stop after these does not end a sentence. `etc.` is left out: it often does.
const ABBREVIATION = /(?:^|[\s(])(?:St|Mt|Mr|Mrs|Ms|Dr|Prof|Jr|Sr|Gen|Col|Lt|Capt|Sgt|Rev|Hon|Fr|vs|Inc|Ltd|Co|Corp|No|Nos|Vol|Fig|approx|c|ca|cca|b|d|r|fl|e\.g|i\.e|a\.k\.a|U\.S|U\.K|Ph\.D)\.$/;
const INITIAL = /(?:^|[\s(])\p{Lu}\.$/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

/**
 * The sentences of some text, in order. Every line is read on its own (a line of a list is one entry). Decimals such as
 * `105.4`, abbreviations such as `St.` and `c.`, initials, and `[3]`-style marks do not confuse it, and it needs no library.
 */
export function splitSentences(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const clean = squash(stripNoteMarks(line));
    if (!clean) continue;
    let carry = '';
    for (const { segment } of segmenter.segment(clean)) {
      const piece = carry ? `${carry} ${segment.trim()}` : segment.trim();
      if (ABBREVIATION.test(piece) || INITIAL.test(piece)) {
        carry = piece;
        continue;
      }
      carry = '';
      if (piece) out.push(piece);
    }
    if (carry) out.push(carry);
  }
  return out;
}

/* ---------- the infobox ---------- */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT_TAGS = new Set(['style', 'script']);
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'br', 'tr', 'td', 'th', 'table', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * A small, forgiving HTML reader: enough to find a table and its rows in Wikipedia's output. Scripts and styles are
 * dropped whole. Nothing here is ever put back into the page, only the text taken out of it.
 */
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const source = String(html ?? '');
  const lower = source.toLowerCase();
  const text = (s) => s && stack.at(-1).children.push(s);
  let last = 0;
  TAG.lastIndex = 0;
  let match;
  while ((match = TAG.exec(source))) {
    text(source.slice(last, match.index));
    last = TAG.lastIndex;
    if (match[0].startsWith('<!--')) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs = {};
    for (const a of match[3].matchAll(ATTRIBUTE)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (RAW_TEXT_TAGS.has(tag)) {
      const close = lower.indexOf(`</${tag}`, last);
      const after = close < 0 ? -1 : source.indexOf('>', close);
      last = TAG.lastIndex = after < 0 ? source.length : after + 1;
    } else if (!VOID_TAGS.has(tag) && !match[3].trimEnd().endsWith('/')) stack.push(node);
  }
  text(source.slice(last));
  return root;
}

const classesOf = (node) => (node.attrs.class ?? '').split(/\s+/);
const hasClass = (node, name) => classesOf(node).includes(name);
const isHidden = (node) => /display\s*:\s*none/i.test(node.attrs.style ?? '') || hasClass(node, 'mw-empty-elt');

/** The text of a node. Footnote marks and hidden bits are left out; `km<sup>2</sup>` stays `km2`. A label drops every `<sup>`. */
function textOf(node, { label = false } = {}) {
  if (typeof node === 'string') return node;
  if (RAW_TEXT_TAGS.has(node.tag) || isHidden(node)) return '';
  if (node.tag === 'sup' && (label || hasClass(node, 'reference'))) return '';
  const inner = node.children.map((child) => textOf(child, { label })).join('');
  return BLOCK_TAGS.has(node.tag) ? ` ${inner} ` : inner;
}

const cleanText = (raw) =>
  squash(decodeEntities(raw))
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,;)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();

function findNode(node, test) {
  if (typeof node === 'string') return null;
  if (test(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, test);
    if (found) return found;
  }
  return null;
}

/**
 * The rows of an article's infobox (the box down the side of the page), from the HTML of its opening section, as
 * `{ label, value }` in plain text. A row for a part of the one above ("• Urban", "• Metro") is folded into that row, so
 * the Area row reads `105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 (1,090.4 sq mi) • Metro 18,940.7 km2 (7,313.0 sq mi)`.
 * Headings, pictures and captions are skipped. An article with no infobox gives an empty list.
 */
export function parseInfobox(html) {
  const table = findNode(parseHtml(html), (n) => n.tag === 'table' && hasClass(n, 'infobox'));
  if (!table) return [];

  const rows = [];
  for (const tr of tableTrs(table)) {
    const cells = tr.children.filter((c) => typeof c !== 'string');
    const th = cells.find((c) => c.tag === 'th');
    const td = cells.find((c) => c.tag === 'td');
    if (!th || !td) continue; // a heading, a picture or a caption
    const label = cleanText(textOf(th, { label: true }));
    const value = cleanText(textOf(td));
    if (!label || !value) continue;

    const part = /^[•·]\s*/.test(label);
    if (part && rows.length > 0) rows.at(-1).parts.push(`${label.replace(/^[•·]\s*/, '')} ${value}`);
    else rows.push({ label: label.replace(/^[•·]\s*/, ''), value, parts: [] });
  }
  return rows.map((r) => ({ label: r.label, value: [r.value, ...r.parts].join(' • ') }));
}

/** The rows of a table, from its own `<tr>`s (not those of a table inside one of its cells). */
function tableTrs(table) {
  return table.children.flatMap((c) => (typeof c === 'string' ? [] : c.tag === 'tr' ? [c] : ['tbody', 'thead', 'tfoot'].includes(c.tag) ? c.children.filter((r) => typeof r !== 'string' && r.tag === 'tr') : []));
}

/* ---------- tables in the body of an article ---------- */

export const MAX_TABLE_ROWS = 300; // rows kept from one table
const MAX_HEADER_CHARS = 60;
const whole = (value, low, high) => Math.min(high, Math.max(low, Number.parseInt(value, 10) || low));

/** A table's cells as a grid: a cell that spans rows or columns fills every place it covers, so each row has a cell under each column. */
function tableGrid(trs) {
  const grid = [];
  const carried = []; // carried[column]: a cell from an earlier row that still covers this row, and for how many more
  for (const tr of trs) {
    const row = [];
    let col = 0;
    const fill = () => {
      while (carried[col]?.left > 0) {
        row[col] = carried[col].cell;
        carried[col].left -= 1;
        col += 1;
      }
    };
    for (const node of tr.children) {
      if (typeof node === 'string' || (node.tag !== 'td' && node.tag !== 'th')) continue;
      fill();
      const cell = { text: cleanText(textOf(node)), th: node.tag === 'th' };
      const across = whole(node.attrs.colspan, 1, 40);
      const down = whole(node.attrs.rowspan, 1, 200);
      for (let k = 0; k < across; k++) {
        row[col] = cell;
        if (down > 1) carried[col] = { cell, left: down - 1 };
        col += 1;
      }
    }
    fill();
    grid.push(Array.from(row));
  }
  return grid;
}

/**
 * One table as text: its column names, and a line for each row: "Petrol engines — Model: 1.6 litre VTi 16v • Years: 2006–present
 * • Top speed: 187 km/h (116 mph) • …". The header row is the first with a heading over every column; a row that is one cell
 * across the whole table is a caption before the header, or a group name after it (the rows below carry it). A table with no
 * rows gives null.
 */
function readTable(table) {
  const grid = tableGrid(tableTrs(table));
  const distinct = (row) => new Set(row.filter(Boolean).map((c) => c.text).filter(Boolean));
  const headerAt = grid.findIndex((row) => row.length >= 2 && row.every((c) => c?.th) && distinct(row).size >= 2);
  const headers = headerAt >= 0 ? grid[headerAt].map((c) => (c?.text ?? '').slice(0, MAX_HEADER_CHARS)) : [];
  const titles = [];
  const rows = [];
  let group = '';
  grid.forEach((row, r) => {
    const cells = row.filter(Boolean);
    if (r === headerAt || cells.length === 0) return;
    if (row.length > 1 && new Set(cells).size === 1) {
      if (!cells[0].text) return;
      if (headerAt < 0 || r < headerAt) titles.push(cells[0].text);
      else group = cells[0].text;
      return;
    }
    if (headerAt >= 0 && (r < headerAt || cells.every((c) => c.th))) return; // more header lines, not data
    const parts = [];
    row.forEach((cell, i) => {
      if (!cell?.text || row[i - 1] === cell) return; // empty, or the same cell again because it spans columns
      const header = headers[i];
      parts.push(header && header !== cell.text ? `${header}: ${cell.text}` : cell.text);
    });
    if (parts.length > 0) rows.push(`${group ? `${group} — ` : ''}${parts.join(' • ')}`);
  });
  if (rows.length === 0) return null;
  const caption = tableCaption(table) || titles.join(' — ');
  return { caption, headers: [...new Set(headers.filter(Boolean))], rows: rows.slice(0, MAX_TABLE_ROWS) };
}

const tableCaption = (table) => {
  const node = table.children.find((c) => typeof c !== 'string' && c.tag === 'caption');
  return node ? cleanText(textOf(node)) : '';
};

/**
 * The tables in the body of an article (the sortable, gridded ones Wikipedia calls "wikitables"), from the article's HTML, each
 * with the section it is in as a `path` ("Second generation (2013–2022) › Engines") and that heading's `anchor`. Infoboxes,
 * navigation boxes and the tables of "See also", "References" and the like are left out. Also returns `headings`, every
 * heading in order (the lead first), so a section that is only a table can be put where it belongs.
 */
export function parseTables(html) {
  const root = parseHtml(html);
  const content = findNode(root, (n) => hasClass(n, 'mw-parser-output')) ?? root;
  const above = [];
  const headings = [{ path: 'Lead', anchor: '' }];
  const tables = [];
  let current = { path: 'Lead', anchor: '', skip: false };

  const walk = (node) => {
    for (const child of node.children) {
      if (typeof child === 'string' || RAW_TEXT_TAGS.has(child.tag) || isHidden(child)) continue;
      if (/^h[2-6]$/.test(child.tag)) {
        const title = cleanText(textOf(child)).replace(/\s*\[edit\]$/i, '');
        if (!title) continue;
        const level = Number(child.tag[1]);
        while (above.length && above.at(-1).level >= level) above.pop();
        above.push({ level, title });
        const path = above.map((h) => h.title).join(' › ');
        current = { path, anchor: anchorOf(title), skip: SKIPPED_SECTIONS.has(title.toLowerCase()) };
        headings.push({ path, anchor: current.anchor });
        continue;
      }
      if (child.tag === 'table') {
        if (hasClass(child, 'wikitable') && !current.skip) {
          const table = readTable(child);
          if (table) tables.push({ path: current.path, anchor: current.anchor, ...table });
        }
        continue; // whatever else a table is, nothing inside it is another section
      }
      walk(child);
    }
  };
  walk(content);
  return { tables, headings };
}

const sameSection = (a, b) => a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');

/**
 * Put the tables of an article into its sections (`[{ path, anchor, sentences }]`, from the plain text), as `tables`. A section that
 * is only a table has no text, so the plain text left it out: it is added here, after the section before it. `parsed` is what
 * `parseTables` gave.
 */
export function mergeTables(sections, { tables = [], headings = [] } = {}) {
  const result = sections.map((s) => ({ ...s, tables: [] }));
  const find = (path) => result.find((s) => sameSection(s.path, path));
  for (const table of tables) {
    let section = find(table.path);
    if (!section) {
      section = { path: table.path, anchor: table.anchor, sentences: [], tables: [] };
      let after = -1;
      for (let i = headings.findIndex((h) => sameSection(h.path, table.path)) - 1; i >= 0 && after < 0; i--) after = result.findIndex((s) => sameSection(s.path, headings[i].path));
      result.splice(after + 1, 0, section);
    }
    section.tables.push({ caption: table.caption, headers: table.headers, rows: table.rows });
  }
  return result;
}

/* ---------- what the search and article calls hand back ---------- */

/** Search results from several searches, one list each, into one: rank by rank so each search gets a say, no repeated titles, no disambiguation pages. */
export function mergeResults(lists, max = MAX_RESULTS) {
  const seen = new Set();
  const merged = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const result = list[i];
      if (!result || /\(disambiguation\)\s*$/i.test(result.title)) continue;
      const key = result.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
  }
  return merged.slice(0, max);
}

/** The places in an article that could hold the answer: the infobox (if it has one), then each section, in order. */
export function articleParts(article) {
  const parts = [];
  if (article.infobox?.length) {
    const labels = clip(article.infobox.map((r) => r.label).join(', '), 300);
    parts.push({ kind: 'infobox', label: 'Infobox', description: `Infobox: ${labels}`, anchor: '', rows: article.infobox });
  }
  for (const s of article.sections ?? []) {
    const tables = s.tables ?? [];
    const columns = [...new Set(tables.flatMap((t) => t.headers))];
    const name = s.path === 'Lead' ? 'Lead: the opening paragraphs, which summarise the article' : s.path;
    parts.push({
      kind: 'section',
      label: s.path,
      description: clip(columns.length ? `${name} · table: ${columns.join(', ')}` : name),
      anchor: s.anchor,
      sentences: s.sentences ?? [],
      tableRows: tables.flatMap((t) => t.rows.map((text) => ({ text, columns: t.headers }))),
    });
  }
  return parts.slice(0, MAX_CHOICES);
}

const PIECE_SEPARATOR = ' • ';
const MAX_PIECES = 60;
/**
 * The pieces of a row (an infobox row, or a row of a table), which is how a row is "chopped up": "Petrol engines — Model: 1.6 litre VTi
 * 16v • Years: 2006–present • Top speed: 187 km/h (116 mph)" is the pieces "Model: 1.6 litre VTi 16v", "Years: 2006–present" and "Top speed:
 * 187 km/h (116 mph)". The group name in front ("Petrol engines —") is not a piece. A row of one piece has none, because there is nothing to choose between.
 */
export function rowPieces(text) {
  const group = /^[^:•]{1,80} — (.+)$/s.exec(text);
  const pieces = (group ? group[1] : text).split(PIECE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  return pieces.length > 1 ? pieces.slice(0, MAX_PIECES).map((p) => clip(p, 200)) : [];
}

/** What Jev can pick from inside a part: an infobox row ("Area: 105.4 km2 …"), a sentence with the ones either side kept for the check, or a row of a table. */
export function partCandidates(part) {
  if (part.kind === 'infobox') return part.rows.map((r) => ({ text: clip(`${r.label}: ${r.value}`), before: '', after: '', pieces: rowPieces(`${r.label}: ${r.value}`) }));
  const { sentences } = part;
  const prose = sentences.map((s, i) => ({ text: clip(s), before: clip(sentences[i - 1] ?? ''), after: clip(sentences[i + 1] ?? '') }));
  // A row of a table: the columns are kept as the context for the check, in place of the sentences either side.
  const rows = (part.tableRows ?? []).map((r) => ({ text: clip(r.text), before: r.columns.length ? clip(`Table columns: ${r.columns.join(', ')}`) : '', after: '', pieces: rowPieces(r.text) }));
  return [...prose, ...rows];
}

/* ---------- asking Jev ---------- */

/** What the question is asking for, to show beside the part Jev chose ("area 62%, population 31%"). Options depend on the kind of question. */
export function meaningOptions(question) {
  const q = ` ${String(question ?? '').toLowerCase()} `;
  if (/\bhow (big|large)\b|\bsize of\b/.test(q)) {
    return { area: 'Its land area', population: 'How many people live there', both: 'Either could be meant', other: 'Something else' };
  }
  if (/\bhow (tall|high)\b/.test(q)) {
    return { height: 'How tall it is from base to top', elevation: 'How high it is above sea level', other: 'Something else' };
  }
  if (/\bhow old\b|\bage of\b/.test(q)) {
    return { age: 'How long ago it began, formed or was made', lifespan: 'How long it lasts or is expected to last', other: 'Something else' };
  }
  if (/\bhow (far|long|deep|wide)\b/.test(q)) {
    return { distance: 'A length or distance', duration: 'A length of time', other: 'Something else' };
  }
  if (/\bhow many\b|\bhow much\b/.test(q)) {
    return { count: 'A count of things or people', amount: 'An amount of money, mass or volume', other: 'Something else' };
  }
  if (/^\s*who\b/.test(q)) return { person: 'A person', group: 'An organisation or group of people', other: 'Something else' };
  if (/^\s*when\b/.test(q)) return { start: 'When it began, opened or was made', end: 'When it ended or was finished', other: 'Something else' };
  if (/^\s*where\b/.test(q)) return { place: 'A place, country or region', position: 'A position such as coordinates or a direction', other: 'Something else' };
  return { fact: 'A specific fact, figure or date', explanation: 'An explanation or a description', other: 'Something else' };
}

const indexKeys = (prefix, items, describe) => Object.fromEntries(items.map((item, i) => [`${prefix}${i}`, describe(item)]));

/** Step 1: which search term is most likely to find the article. Options are `t0`, `t1`, …; `readChoice(answer, terms, 't')` maps them back. */
export function buildTermRequest(question, terms) {
  return {
    state: { question },
    questions: {
      term: { type: 'choice', instructions: 'Which search term is most likely to find the Wikipedia article that answers `question`?', criteria: indexKeys('t', terms, (t) => t) },
    },
  };
}

/** Step 2: which article, plus a Yes / No for each snippet: does it already state the answer? Options are `a0`…, and `none`. */
export function buildArticleRequest(question, results, { snippets = true } = {}) {
  const questions = {
    article: {
      type: 'choice',
      instructions: 'Which Wikipedia article is most likely to state the answer to `question`? Prefer the main article about the thing asked about over a list, a spin-off or an article about something related to it. Each option is a title and the start of the article where the search matched.',
      criteria: { ...indexKeys('a', results, (r) => clip(`${r.title}: ${r.snippet}`, SNIPPET_OPTION_CHARS + 60)), none: 'None of these articles is likely to state it' },
    },
  };
  if (snippets) results.forEach((r, i) => {
    questions[`s${i}`] = { type: 'noul', instructions: `Does this snippet from the article "${r.title}" state the answer to \`question\`? Snippet: ${clip(r.snippet, SNIPPET_OPTION_CHARS)}` };
  });
  return { state: { question }, questions };
}

/** Step 3: which part of the article, and (in the same request) what the question means. Options are `p0`…, and `none`. */
export function buildPartRequest(question, title, parts) {
  return {
    state: { question, article: title },
    questions: {
      part: {
        type: 'choice',
        instructions: 'Which part of the article `article` is most likely to state the answer to `question`?',
        criteria: { ...indexKeys('p', parts, (p) => p.description), none: 'None of these parts is likely to state it' },
      },
      meaning: { type: 'choice', instructions: 'What is `question` asking for?', criteria: meaningOptions(question) },
    },
  };
}

/**
 * Step 4: which candidate states the answer. A part with more than 250 candidates is cut into chunks, one Choice each
 * (`answer0`, `answer1`, …) in the same request, and each has its own `none`. Returns the request and the chunks.
 */
export function buildAnswerRequest(question, title, partLabel, candidates) {
  const chunks = [];
  for (let i = 0; i < candidates.length && chunks.length < MAX_CHUNKS; i += MAX_CHOICES) chunks.push(candidates.slice(i, i + MAX_CHOICES));
  const questions = {};
  chunks.forEach((chunk, c) => {
    questions[`answer${c}`] = {
      type: 'choice',
      instructions: 'Which of these sentences, from the part `part` of the article `article`, states the answer to `question`?',
      criteria: { ...indexKeys('c', chunk, (cand) => cand.text), none: 'None of these states the answer' },
    };
  });
  return { request: { state: { question, article: title, part: partLabel }, questions }, chunks };
}

/** Step 5: a Yes / No on the chosen candidate, with the sentence either side so it is read in context. */
export function buildCheckRequest(question, title, partLabel, candidate) {
  const state = { question, article: title, part: partLabel, sentence: candidate.text };
  if (candidate.before) state.before = candidate.before;
  if (candidate.after) state.after = candidate.after;
  return {
    state,
    questions: {
      answers: {
        type: 'noul',
        instructions: 'Does `sentence` state the answer to `question` for exactly what the question specifies, with every detail in it (such as the model, engine, year or place) matching, rather than for something similar or something else, or just mentioning the subject? (`before` and `after`, when given, are the text around it.)',
      },
    },
  };
}

/**
 * Step 6, after a row has passed the check: which piece of it (a cell of a table row, or one part of an infobox row) is the answer. The
 * options are the row's own pieces, `r0`, `r1`, …, and `none` for when no one piece is it (the whole row is kept then). Returns the request and
 * the pieces, so the answer can be mapped back.
 */
export function buildRefineRequest(question, title, partLabel, candidate) {
  const pieces = (candidate.pieces ?? []).slice(0, MAX_CHOICES);
  return {
    request: {
      state: { question, article: title, part: partLabel, row: candidate.text },
      questions: {
        refine: {
          type: 'choice',
          instructions: 'Which piece of the row `row` states the answer to `question`? Each option is one piece of that row.',
          criteria: { ...indexKeys('r', pieces, (p) => p), none: 'No single piece states it' },
        },
      },
    },
    pieces,
  };
}

/* ---------- reading Jev's answers ---------- */

/**
 * A Choice answer as a ranking of `items` (whose options were keyed `prefix0`, `prefix1`, …), best first, with each one's
 * probability, and the probability of `none`. Every item is listed, so an answer that names fewer still ranks them all.
 */
export function readChoice(answer, items, prefix) {
  const probs = answer?.probabilities ?? (answer?.choice ? { [answer.choice]: 1 } : {});
  const ranked = items.map((item, index) => ({ item, index, p: Number(probs[`${prefix}${index}`]) || 0 }));
  ranked.sort((a, b) => b.p - a.p || a.index - b.index);
  return { ranked, none: Number(probs.none) || 0 };
}

/** The answers to a chunked step 4, joined: every candidate with its probability and its chunk's `none`, best first. */
export function readAnswerChunks(answers, chunks) {
  const all = [];
  chunks.forEach((chunk, c) => {
    const { ranked, none } = readChoice(answers?.[`answer${c}`], chunk, 'c');
    for (const r of ranked) all.push({ ...r, none, chunk: c });
  });
  return all.sort((a, b) => b.p - a.p || a.chunk - b.chunk || a.index - b.index);
}

/** A Yes / No answer as a probability from 0 to 1. */
export const readYesNo = (answer) => {
  const p = Number(answer?.noul);
  return Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
};

/** The answer to the meaning question: each option (keyed by its own name, not an index) with its probability, best first. */
export function readMeaning(answer, options) {
  const probs = answer?.probabilities ?? (answer?.choice ? { [answer.choice]: 1 } : {});
  return Object.keys(options)
    .map((label) => ({ label, p: Number(probs[label]) || 0 }))
    .sort((a, b) => b.p - a.p);
}

/* ---------- saved answers ---------- */

export const MAX_SAVED = 50;
export const MAX_SAVED_OPTIONS = 300; // options kept for a step of a saved answer: more than a step ever has (a part has at most 250 sentences a Choice, and 4 Choices)

const STEP_IDS = new Set(['term', 'article', 'part', 'answer', 'check', 'refine']);
const text = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const chance = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
const cleanOptions = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((o) => o && typeof o.key === 'string')
    .slice(0, MAX_SAVED_OPTIONS)
    .map((o) => ({ key: text(o.key, 40), label: text(o.label, MAX_OPTION_CHARS + 1), p: chance(o.p) }));
const cleanState = (state) =>
  Object.fromEntries(
    Object.entries(state && typeof state === 'object' && !Array.isArray(state) ? state : {})
      .filter(([, v]) => typeof v === 'string')
      .slice(0, 6)
      .map(([k, v]) => [text(k, 30), text(v, 300)]),
  );

/**
 * The steps of a run, checked: what the trail is drawn from, and so what is stored with a saved answer. Only text and
 * numbers are kept, cut to a sensible length, and only the five known kinds of step.
 */
export function cleanTrail(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((step) => step && STEP_IDS.has(step.id))
    .slice(0, 60)
    .map((step) => {
      const meaning = step.meaning && typeof step.meaning === 'object' ? step.meaning : null;
      return {
        id: step.id,
        title: text(step.title, 60),
        label: text(step.label, MAX_OPTION_CHARS + 1),
        p: chance(step.p),
        note: text(step.note, 200),
        skipped: text(step.skipped, 200),
        reused: step.reused === true,
        instructions: text(step.instructions, 700),
        state: cleanState(step.state),
        chosen: text(step.chosen, 40),
        options: cleanOptions(step.options),
        confidence: Number.isFinite(step.confidence) ? chance(step.confidence) : null,
        meaning: meaning ? { label: text(meaning.label, 60), p: chance(meaning.p), instructions: text(meaning.instructions, 700), state: cleanState(meaning.state), chosen: text(meaning.chosen, 40), options: cleanOptions(meaning.options), confidence: Number.isFinite(meaning.confidence) ? chance(meaning.confidence) : null } : null,
      };
    });
}

/** How much a run cost, as kept with a saved answer. */
export const cleanStats = (stats) => ({
  requests: count(stats?.requests),
  tokens: count(stats?.tokens),
  ms: count(stats?.ms),
  articles: count(stats?.articles),
  terms: (Array.isArray(stats?.terms) ? stats.terms : []).filter((t) => typeof t === 'string').slice(0, 10).map((t) => text(t, 200)),
});

/** What is kept when an answer is saved: the question, the quote, where it came from, how sure Jev was, and the steps and their cost. Text and numbers only. */
export function savedAnswer({ question, answer, trail = [], stats = {}, ts, id }) {
  return { id, ts, question, text: answer.text, refined: answer.refined ?? '', title: answer.title, part: answer.part, url: answer.url, checked: answer.checked, p: answer.p, trail: cleanTrail(trail), stats: cleanStats(stats) };
}

const sameAnswer = (a, b) => a.question === b.question && a.url === b.url && a.text === b.text;

/** A new list with `entry` first. Saving the same answer to the same question again moves it to the top instead of repeating it. Keeps the newest 50. */
export const addSavedAnswer = (list, entry) => [entry, ...list.filter((s) => !sameAnswer(s, entry))].slice(0, MAX_SAVED);

/**
 * What was stored, checked before it is used: anything that is not a well-formed saved answer is dropped, and a link that
 * is not an address on Wikipedia is dropped with its answer, since the page shows it as a link.
 */
export function cleanSavedAnswers(stored) {
  if (!Array.isArray(stored)) return [];
  const isText = (v) => typeof v === 'string';
  return stored
    .filter((s) => s && isText(s.id) && isText(s.question) && isText(s.text) && isText(s.title) && isText(s.url) && s.url.startsWith(`${WIKI_ORIGIN}/wiki/`) && !/\s/.test(s.url))
    .map((s) => ({ id: s.id, ts: count(s.ts), question: s.question, text: s.text, refined: isText(s.refined) ? s.refined.slice(0, 500) : '', title: s.title, part: isText(s.part) ? s.part : '', url: s.url, checked: chance(s.checked), p: chance(s.p), trail: cleanTrail(s.trail), stats: cleanStats(s.stats) }))
    .slice(0, MAX_SAVED);
}
