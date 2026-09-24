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
export const ABOUT_CHARS = 400; // the Lead excerpt given as context for a part with none of its own (an infobox or table row)

const clip = (text, max = MAX_OPTION_CHARS) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * A short excerpt of the article's Lead (its first sentences, up to `ABOUT_CHARS`), to ground steps 4 and 5 in what
 * the subject actually is. An infobox row or a table row has no `before`/`after` of its own (a bare "Developer:
 * TypeSafe AI" has no neighbours to give it context, unlike a sentence or a row of a table with column headers), so
 * without this, ranking or checking among them happens with nothing but the bare label and value to go on.
 */
export const leadExcerpt = (sentences) => (sentences?.length ? clip(sentences.join(' '), ABOUT_CHARS) : null);

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

/* ---------- question classification (step 0) ---------- */

// The tuned definitions from the labelled test set: what each question type means, verbatim, so Jev classifies against
// the same criteria that were refined against real examples. `QUESTION_TYPE_LABELS` is the short name for the trail.
export const QUESTION_TYPE_LABELS = {
  'direct-fact': 'Direct Fact',
  attribute: 'Attribute',
  'multi-part': 'Multi-Part',
  comparison: 'Comparison',
  temporal: 'Temporal',
  'cause-effect': 'Cause & Effect',
  'entity-from-clues': 'Entity from Clues',
  'reverse-lookup': 'Reverse Lookup',
  negation: 'Negation',
  'false-premise': 'False Premise',
  'ambiguous-entity': 'Ambiguous Entity',
  superlative: 'Superlative',
  counting: 'Counting',
  'cross-entity': 'Cross-Entity',
  'historical-change': 'Historical Change',
  'set-membership': 'Set Membership',
  unanswerable: 'Unanswerable',
};
export const QUESTION_TYPE_CRITERIA = {
  'direct-fact':
    "Asks for a specific, well-established factual answer that can be retrieved directly. Includes cases where the entity is described rather than named, as long as the description is a single, canonical, widely-known epithet that functions as the fact's common label (e.g., \"the first person to walk on the Moon,\" \"the discoverer of the theory of evolution\") — no multi-clue reasoning is required, just recall. Excludes questions where the entity must be identified by satisfying an explicitly negated condition stated in the question (not, never, did not, without, etc.) — even when the underlying fact is well-known. Those are Negation, regardless of how directly recallable the answer is.",
  attribute:
    "Asks for a property or associated detail (population, location, language, occupation, date, capital, status, etc.) of an explicitly identified entity, where that entity is the grammatical subject of the question (e.g., \"What is Japan's population?\"). Excludes fixed universal facts or definitions (e.g., chemical symbols, mathematical constants, unit conversions), which are Direct Fact. Also excludes cases where the requested property does not meaningfully apply to the named entity (e.g., asking a city's \"height\") — classify those as False Premise instead. Does not apply when the question instead names an object, landmark, or work and asks which entity it belongs to — see Reverse Lookup.",
  'multi-part':
    'Contains two or more distinct information requests that can be answered independently. Takes precedence over other categories when ≥2 independently-answerable asks are present, even if one sub-part would otherwise match another category on its own.',
  comparison: 'Asks to compare two or more explicitly identified entities, events, places, quantities, or properties.',
  temporal:
    'Primarily asks when something happened, what year or date it occurred, how long it lasted, or about the chronological order or timing of events.',
  'cause-effect':
    'Asks why something happened, what caused it, what resulted from it, or about a causal relationship between events or conditions. Includes questions asking how one entity/event influenced, affected, or contributed to another (causal-verb framing). Takes precedence over Cross-Entity whenever a causal verb (influence, effect, contribution, result, cause) is used.',
  'entity-from-clues':
    'Asks for the identity of an unnamed entity that must be identified by combining multiple distinguishing details, or from an uncommon/non-canonical description requiring inference rather than recall of a well-known label. (Contrast with Direct Fact, which covers single, famous, standard descriptors.)',
  'reverse-lookup':
    'Asks which entity is associated with a specific object, landmark, place, work, invention, event, or other distinctive item named in the question, where that named item is the object being pointed at (e.g., "Which city is home to the Eiffel Tower?"). This takes precedence over Attribute whenever a specific landmark/object/work is named and the question asks what it belongs to, is located in, or was created by.',
  negation:
    "Asks for something that does not satisfy a condition, using negative concepts such as not, never, except, didn't, without, or equivalent wording. If the question's negated premise is itself factually false (e.g., implies an exception exists when none actually does), classify as False Premise instead.",
  'false-premise':
    'Contains an assumption presented as true that is factually false, historically incorrect, or contradicted by reliable information, so the premise must be recognized as incorrect before answering. Includes cases where a negation-phrased question presupposes a false exception, and cases where an Attribute-style question asks for a property that does not meaningfully apply to the named entity.',
  'ambiguous-entity':
    'Contains a name or term that could reasonably refer to multiple different entities, and no clearly dominant/default referent is implied by the rest of the question. If context makes one reading clearly primary (e.g., "Washington" defaulting to Washington, D.C. in a founding-date question), classify by the question\'s main category instead (e.g., Temporal) rather than as Ambiguous Entity.',
  superlative:
    'Asks to identify an entity because it has an extreme or ranked property relative to others, such as largest, smallest, oldest, newest, longest, highest, most populous, or similar. A well-established historical fact involving "first" or "last" is not automatically a Superlative.',
  counting: 'Asks how many entities, items, occurrences, or members satisfy a specified condition.',
  'cross-entity':
    'Asks about a relationship, connection, association, influence, or interaction between two or more identifiable entities. Reserved for associative or comparative relationships without a causal verb (e.g., "collaborated with," "is known for," "relates to"). When the question asks specifically about causal impact between entities/events, classify as Cause & Effect instead. Requires two or more entities to be explicitly named in the question itself. Does not apply when only one entity is named and the question asks to identify an unnamed second entity connected to it (e.g., "Which river is associated with Mesopotamia?") — those are Attribute or Reverse Lookup depending on framing, not Cross-Entity.',
  'historical-change':
    'Asks how an entity, place, institution, territory, name, status, or other subject changed between different historical periods, including historical-to-modern names or statuses.',
  'set-membership': 'Asks which entities belong to a specified group, organization, alliance, category, geographic set, or other defined collection.',
  unanswerable:
    'When the sequence lacks coherent grammatical structure or a discernible relationship between its words, even if individual words are topical, temporal, numeric, or otherwise meaningful in isolation. A single coherent-sounding word or phrase embedded in an otherwise disconnected sequence does not establish intent for any other category.',
};

/**
 * Step 0: what kind of question this is, two gates, and what the question is asking for (`meaningOptions`) — all in
 * one request (so it costs one call to Jev, not four): a Choice across `QUESTION_TYPE_CRITERIA` (verbatim, tuned
 * criteria), a Yes / No for each gate, and the "what does it ask for" Choice that used to be asked again for every
 * article tried (it only depends on `question`, never on the article), and too late to help choose the right part of
 * one (step 3) — only the sentence within it (step 4). Settling it here, before any article is opened, lets both use it.
 */
export function buildClassifyRequest(question) {
  return {
    state: { question },
    questions: {
      type: { type: 'choice', instructions: 'What kind of question is `question`? Choose the category that best fits it.', criteria: QUESTION_TYPE_CRITERIA },
      falsePremise: {
        type: 'noul',
        instructions:
          '`question` contains an assumption presented as true. Is that assumption factually false, historically incorrect, or contradicted by reliable information, so it must be corrected before the question can be answered?',
      },
      unanswerable: {
        type: 'noul',
        instructions:
          'Is `question` unanswerable because it lacks a coherent grammatical structure or a discernible request, even if individual words in it are topical or otherwise meaningful in isolation?',
      },
      meaning: { type: 'choice', instructions: 'What is `question` asking for?', criteria: meaningOptions(question) },
    },
  };
}

/**
 * Step 0's Choice, ranked best first (every type listed), the two gates as probabilities from 0 to 1, and the meaning
 * Choice, ranked the same way `readMeaning` does (with its own options, to look up a ranked key's description).
 */
export function readClassify(answers, question) {
  const probs = answers?.type?.probabilities ?? (answers?.type?.choice ? { [answers.type.choice]: 1 } : {});
  const ranked = Object.keys(QUESTION_TYPE_CRITERIA)
    .map((key) => ({ key, p: Number(probs[key]) || 0 }))
    .sort((a, b) => b.p - a.p);
  const meaningOpts = meaningOptions(question);
  return {
    ranked,
    falsePremise: readYesNo(answers?.falsePremise),
    unanswerable: readYesNo(answers?.unanswerable),
    meaning: readMeaning(answers?.meaning, meaningOpts),
    meaningOptions: meaningOpts,
  };
}

/* ---------- multi-entity splitting (Multi-Part and Comparison) ---------- */

// A conjunction that starts a second, independently-answerable request ("…, and which countries does it pass through?").
// Only splits before a question word or an auxiliary, so entity lists ("Canada and China") are left alone.
const MULTI_PART_SPLIT = /\s*,?\s+and\s+(?=(?:which|what|who|whom|whose|when|where|why|how|does|do|did|is|are|was|were)\b)/i;
const PRONOUN = /\b(it|he|she|they|this|that|those|these)\b/i;

/**
 * Split a Multi-Part question into its independently-answerable parts, best-effort. Returns `null` when no confident
 * split is found (one part, or the question doesn't match the pattern), rather than guessing. A pronoun in a later
 * part ("…and which countries does it pass through?") is left as `it` here; `resolvePronoun` fills it in once the
 * part before it has an answer, since Jev only chooses between options code gives it — it cannot write that
 * substitution itself.
 */
export function splitMultiPart(question) {
  const parts = String(question)
    .split(MULTI_PART_SPLIT)
    .map((p) => squash(p))
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.map((p) => (/[.?!]$/.test(p) ? p : `${p}?`));
}

/** Replace the first pronoun in `part` with `entity` ("which countries does it pass through" → "…does Amazon River pass through"). */
export function resolvePronoun(part, entity) {
  return PRONOUN.test(part) ? part.replace(PRONOUN, entity) : part;
}

// "Which has more surface area, Canada or China?" / "Which is older, the Eiffel Tower or the Statue of Liberty?"
const COMPARISON = /^\s*which\s+(?:one\s+)?(?:has|had|is|was|are|were)\s+(?:more|less|greater|higher|larger|bigger|smaller|older|younger|longer|shorter)\s+([^,?]+?)\s*,\s*(.+?)\s+or\s+(.+?)\s*\??\s*$/i;

/**
 * Parse a two-entity Comparison question into the property being compared and the two entities, best-effort. Returns
 * `null` when the question doesn't match a recognised comparison pattern, so it can fall back to "uncertain" instead
 * of guessing at entities that aren't really there.
 */
export function parseComparison(question) {
  const m = COMPARISON.exec(String(question));
  if (!m) return null;
  const [, property, a, b] = m;
  return { property: squash(property), entities: [squash(a), squash(b)] };
}

/** The sub-question to ask about one entity of a Comparison ("What is Canada's surface area?"). */
export const attributeQuestion = (entity, property) => `What is ${/^(the|a|an)\s/i.test(entity) ? entity : `${entity}'s`} ${property}?`;

/** Step, after both entities' answers are found: a Choice between them, so Jev decides the comparison, not code parsing numbers out of text. */
export function buildCompareRequest(question, property, entities, texts) {
  const pairs = entities.map((entity, i) => ({ entity, text: texts[i] }));
  return {
    state: { question, property },
    questions: {
      compare: {
        type: 'choice',
        instructions: 'Given these two facts, which one has more, or a higher/greater value of, `property`? Each option names the entity and states the fact found about it.',
        criteria: indexKeys('e', pairs, (pair) => clip(`${pair.entity}: ${pair.text}`)),
      },
    },
  };
}

/* ---------- negation (candidate enumeration) ---------- */

// "Which U.S. state has never held a presidential primary?" → captures "U.S. state" as the set to enumerate.
const NEGATION_SUBJECT = /^\s*(?:which|what)\s+([a-z][\w\s.'-]*?)\s+(?:has|have|had|does|do|did|is|are|was|were)\s+(?:never|not|no|n't)\b/i;
// The condition, with its negation removed, phrased as a plain yes/no about a candidate: "held a presidential primary".
const NEGATION_STRIP = /\b(never|not\s+once|n't|without\s+ever)\b\s*/gi;

/** The set to search for ("U.S. state" → "List of U.S. states"), and a per-candidate Yes/No template, for a Negation question. */
export function parseNegation(question) {
  const m = NEGATION_SUBJECT.exec(String(question));
  if (!m) return null;
  const subject = squash(m[1]);
  const listQuery = `List of ${/s$/i.test(subject) ? subject : `${subject}s`}`;
  const positive = squash(String(question).replace(NEGATION_STRIP, '').replace(/\?\s*$/, ''));
  return { subject, listQuery, positive };
}

// After the subject is swapped for a candidate ("Which U.S. state has held…" → "Which Wyoming has held…"), the leading
// "which"/"what" no longer makes sense as a question word; this puts the auxiliary back in front to make it one
// ("Has Wyoming held a presidential primary?"), since Jev is asked a Yes/No, not to pick from a list.
const NEEDS_INVERSION = /^(?:which|what)\s+(.+?)\s+(has|have|had|does|do|did|is|are|was|were)\s+(.+)$/i;

/** The Yes/No question for one candidate: the question's subject phrase, and the candidate's name, swapped into the positive form. */
export function candidateQuestion(positive, subject, candidate) {
  const re = new RegExp(`\\b${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const substituted = re.test(positive) ? positive.replace(re, candidate) : `${positive} — considering ${candidate}`;
  const inverted = NEEDS_INVERSION.exec(substituted);
  if (inverted) {
    const [, subjectPart, aux, rest] = inverted;
    return `${aux[0].toUpperCase()}${aux.slice(1)} ${subjectPart} ${rest}?`;
  }
  return /[.?!]$/.test(substituted) ? substituted : `${substituted}?`;
}

/** One batched request: a Yes/No per candidate, asking whether the (now positive) condition holds for it. */
export function buildFilterRequest(question, positive, subject, candidates) {
  const questions = {};
  candidates.slice(0, MAX_CHOICES).forEach((c, i) => {
    questions[`n${i}`] = { type: 'noul', instructions: `Is the answer yes to this question: "${candidateQuestion(positive, subject, c)}"?` };
  });
  return { state: { question }, questions };
}

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

/**
 * Step 3: which part of the article. `meaning` is step 0's own answer to "what is `question` asking for?" (its
 * description) — when given, it is folded into the instructions, the same way `buildAnswerRequest` does, so an
 * infobox of raw facts isn't picked for a question asking for an explanation, and vice versa; that question is left
 * out of this request, since it was already asked once, up front, rather than asked again for every article tried.
 * When not given (`classify: false`), "what the question means" is asked here instead, in the same request — but
 * only found out after the part is already chosen, too late to inform this choice, only the next one.
 */
export function buildPartRequest(question, title, parts, meaning) {
  const questions = {
    part: {
      type: 'choice',
      instructions: meaning
        ? `Which part of the article \`article\` is most likely to state the answer to \`question\`, which is asking for ${lowerFirst(meaning)}?`
        : 'Which part of the article `article` is most likely to state the answer to `question`?',
      criteria: { ...indexKeys('p', parts, (p) => p.description), none: 'None of these parts is likely to state it' },
    },
  };
  if (!meaning) questions.meaning = { type: 'choice', instructions: 'What is `question` asking for?', criteria: meaningOptions(question) };
  return {
    state: { question, article: title },
    questions,
  };
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Step 4: which candidate states the answer. A part with more than 250 candidates is cut into chunks, one Choice each
 * (`answer0`, `answer1`, …) in the same request, and each has its own `none`. `meaning` is step 3's own answer to
 * "what is `question` asking for?" (its description, e.g. "An explanation or a description") — when given, it is
 * folded into the instructions, so the candidate has to match not just the topic but the kind of thing being asked
 * for. Left out (or the catch-all "Something else") when step 3 wasn't sure, rather than guessing. Returns the
 * request and the chunks.
 */
export function buildAnswerRequest(question, title, partLabel, candidates, meaning, about) {
  const chunks = [];
  for (let i = 0; i < candidates.length && chunks.length < MAX_CHUNKS; i += MAX_CHOICES) chunks.push(candidates.slice(i, i + MAX_CHOICES));
  const questions = {};
  const asks = meaning ? `states the answer to \`question\`, which is asking for ${lowerFirst(meaning)}` : 'states the answer to `question`';
  const aboutNote = about ? ' (`about` is a short excerpt describing the subject, for context.)' : '';
  const state = { question, article: title, part: partLabel };
  if (about) state.about = about;
  chunks.forEach((chunk, c) => {
    questions[`answer${c}`] = {
      type: 'choice',
      instructions: `Which of these sentences, from the part \`part\` of the article \`article\`, ${asks}?${aboutNote}`,
      criteria: { ...indexKeys('c', chunk, (cand) => cand.text), none: 'None of these states the answer' },
    };
  });
  return { request: { state, questions }, chunks };
}

/**
 * Step 5: a Yes / No on the chosen candidate, with the sentence either side so it is read in context. `about` (see
 * `leadExcerpt`) is the same grounding step 4 got, for a candidate — an infobox or table row — with no `before`/`after`
 * of its own to check it against.
 */
export function buildCheckRequest(question, title, partLabel, candidate, about) {
  const state = { question, article: title, part: partLabel, sentence: candidate.text };
  if (candidate.before) state.before = candidate.before;
  if (candidate.after) state.after = candidate.after;
  if (about) state.about = about;
  return {
    state,
    questions: {
      answers: {
        type: 'noul',
        instructions: `Does \`sentence\` state the answer to \`question\` for exactly what the question specifies, with every detail in it (such as the model, engine, year or place) matching, rather than for something similar or something else, or just mentioning the subject? (\`before\` and \`after\`, when given, are the text around it.${about ? ' `about` is a short excerpt describing the subject, for context.' : ''})`,
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

/** The answers to a batched negation filter: each candidate with the probability that the positive condition holds for it. */
export function readFilter(answers, candidates) {
  return candidates.slice(0, MAX_CHOICES).map((candidate, i) => ({ candidate, p: readYesNo(answers?.[`n${i}`]) }));
}

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

const STEP_IDS = new Set(['term', 'article', 'part', 'answer', 'check', 'refine', 'classify', 'gate', 'meaning', 'subquestion', 'compare', 'negation']);
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
 * numbers are kept, cut to a sensible length, and only the known kinds of step. A `subquestion` step (Multi-Part or
 * Comparison) keeps its own nested trail the same way, one level deep — a sub-run is never itself classified, so it
 * can never contain another `subquestion`.
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
        sub: Array.isArray(step.sub) ? cleanTrail(step.sub) : null,
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
