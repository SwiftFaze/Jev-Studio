# Plan: Wikipedia answer (a new page under Tools)

Branch: `feat/wikipedia-answer` (from `develop`). Written 2026-09-21.

## Goal

Ask a plain question ("How big is Paris?") and get back **a quote from Wikipedia that answers it**, with a link to the
section it came from and a **trail** showing every step Jev took and how sure it was:

```
How big is Paris?
  1. Search term      "Paris"                                   91%
  2. Article          Paris                                     94%   (of 12 results)
  3. Part             Infobox                                   81%   meaning: area 62%, population 31%
  4. Answer           "Area: City 105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 • Metro 18,940.7 km2"   88%
     Checked          answers the question                      0.93
  → https://en.wikipedia.org/wiki/Paris
```

Jev never writes the answer. Code builds a list of candidates at each step and Jev **picks** one. The answer is always
text that is really on the page, so it can be cited and cannot be invented. When it goes wrong, the trail shows which
step went wrong.

## What the spike showed (live API, 2026-09-21)

- **Search with the whole question is noisy.** `srsearch=how big is paris` ranks *How Big, How Blue, How Beautiful*
  1st, *Paris Is Burning* 2nd and *Paris* 3rd. `srsearch=Paris` ranks *Paris* 1st. So both the search term and the
  article have to be picked by Jev, not taken from the top of the list.
- **The snippet can already hold the answer.** Paris's search snippet: "…population of 2.04 million in an area of
  105.4 km2 (40.7 sq mi)…".
- **The plain-text extract has the whole article with headings in one call** (`prop=extracts&explaintext=1&exsectionformat=wiki`,
  about 90 KB for Paris, headings as `== Etymology ==`), but it **leaves out the infobox**.
- **The infobox is in `action=parse&prop=text&section=0`** as `<table class="infobox ib-settlement vcard">`. Its Area
  row is the best answer to "how big": `Area 105.4 km2 (40.7 sq mi) • Urban 2,824.2 km2 … • Metro 18,940.7 km2 …`.
- `prop=sections` is deprecated in favour of `prop=tocdata`. We don't need either, because the extract has the headings.

## How it works

The page runs the steps, the same way the Steam page does. The local server only fetches from Wikipedia, because the
Content-Security-Policy (`default-src 'self'`) stops the page calling Wikipedia itself, and Wikimedia wants a
descriptive `User-Agent`, which a browser cannot set. Jev is called through the existing `/api/run`, so the API key,
mock mode and the token counter all work unchanged.

| Step | Code | Jev (one request per row) |
|---|---|---|
| 1. Search term | `searchTerms(question)`: the question as typed, the question without question words and stopwords, each run of content words, each capitalised run. Deduplicated, at most 10. | **Choice** `term`: "Which search term is most likely to find the Wikipedia article that answers the question?" |
| 2. Article | `/api/wikipedia/search` with the chosen term (and the runner-up when the choice is under 60% sure), merged and deduplicated, `(disambiguation)` titles dropped | **Choice** `article` over *title + snippet*, plus `none`. Asked in the same request: a **Yes / No** per snippet, "Does this snippet state the answer?" |
| 3. Part | `/api/wikipedia/article` returns the infobox rows and the sections as sentences | **Choice** `part` over `Infobox` + section paths ("Geography › Climate") + `none`. Asked in the same request: **Choice** `meaning`, "Which sense of the question is meant?", with options built from the question type (for "how big": area, population, both, other) |
| 4. Answer | Candidates: the infobox rows, or the sentences of the chosen section. Each is cut to 400 characters, with at most 250 per Choice (the limit is 255); longer sections are split into chunks. | **Choice** `answer` over the candidates + `none` |
| 5. Check | The chosen candidate with the sentence either side of it | **Yes / No** `answers`: "This text is from part P of article A, so its subject is that article's subject — is it the thing the question asks for, rather than a different fact about the same subject?" |

**When the answer is found:** `answers` ≥ 0.6 and `answer` ≠ `none`. Show the quote, the link
(`https://en.wikipedia.org/wiki/<Title>#<Anchor>`) and the trail. The threshold is a starting point, to be tuned on
the examples.

**When it isn't found**, the steps go back without asking Jev again where they can, by reusing the distributions
already returned:

1. The next part by probability from step 3 (up to 3 parts per article), repeating steps 4 and 5.
2. The next article by probability from step 2 (up to 3 articles), repeating from step 3.
3. Give up at **12 Jev requests** and show "Not found", with the trail and the best candidate seen.

The best case is 5 requests.

**Snippet answer:** if a snippet's Yes / No in step 2 is ≥ 0.8, show it straight away as a *quick answer*, marked as
coming from the search snippet, while the full path keeps going to confirm it. (Snippets have ellipses and can be
cut short mid-sentence.)

### Example request (step 3)

```json
{
  "state": {
    "question": "How big is Paris?",
    "article": "Paris",
    "parts": ["Infobox: Area, Population, Elevation, Time zone, …", "Geography", "Geography › Location", "Demographics", "…"]
  },
  "questions": {
    "part": {
      "type": "choice",
      "instructions": "Which part of the article `article` is most likely to state the answer to `question`?",
      "criteria": { "p0": "Infobox", "p1": "Geography", "p2": "Geography › Location", "p3": "Demographics", "none": "None of these parts is likely to state it" }
    },
    "meaning": {
      "type": "choice",
      "instructions": "What is `question` asking for?",
      "criteria": { "area": "Its land area", "population": "How many people live there", "both": "Either could be meant", "other": "Something else" }
    }
  }
}
```

The option keys are indexes (`p0`, `p1`, …), and code maps them back to candidates. The criteria text is what Jev
reads. To give the Infobox option a fair chance against a heading, its criteria lists the infobox's row labels.

## Files

| File | What |
|---|---|
| `src/wikipedia.js` | Modelled on `src/steam.js`: `WikipediaError`, `validateSearchRequest`, `validateArticleRequest`, `searchWikipedia`, `fetchArticle`. Fixed host `en.wikipedia.org`, `User-Agent: JevStudio/<version> (https://github.com/SwiftFaze/Jev-Studio)`, 15 s timeout, 429 handled like Steam. `fetchArticle` makes two calls, one after the other: the extract, then `parse` of section 0 for the infobox. `redirects=1`, and `pageprops` to report disambiguation pages. |
| `src/server.js` | `POST /api/wikipedia/search` `{ query, limit≤20 }` → `{ results: [{ title, snippet }] }`, and `POST /api/wikipedia/article` `{ title }` → `{ title, url, disambiguation, infobox: [{ label, value }], sections: [{ path, anchor, sentences }] }`. Both work in mock mode (only Jev is mocked). |
| `public/lib/wikipedia.js` | Pure functions, shared with the server as `cleanReviewText` is: `searchTerms`, `stripSnippet` (drops `<span class="searchmatch">`, decodes entities), `splitSections` (parses `== h ==` levels into paths and anchors), `splitSentences` (`Intl.Segmenter`, no dependency; drops `[3]`-style footnote marks), `parseInfobox` (rows of `th`/`td` from the infobox table, text only), `meaningOptions(question)`, and the question builders for each step. |
| `public/lib/wikipedia-run.js` | The step machine: given the answers so far, what to ask next, when to go back, and when to stop. Pure, with `fetch`/`run` passed in, so it can be tested without a browser. |
| `public/ui/wikipedia.js` | The page: question box, *Find answer* / *Stop*, the answer card (quote, link, quick answer), and the trail (each step's choice, its probability, and the runners-up folded underneath). |
| `public/ui/api.js` | `postWikipediaSearch`, `postWikipediaArticle` |
| `public/index.html`, `public/ui/state.js`, `public/app.js` | The *Wikipedia answer* nav item under Tools, `mode-wikipedia`, `pane-wikipedia`, `runbar-wikipedia` |
| `public/templates.js` | Examples: How big is Paris? · How tall is Mount Everest? · Who wrote *Frankenstein*? · When was the Eiffel Tower finished? · How old is Mercury? (ambiguous: planet, element, god) |
| `README.md` | A *Wikipedia answer* section, like *Steam reviews in detail* |

Wikipedia's article HTML is never put into the page. The server pulls out text only, and the UI renders that text as
text.

## Tests

- `test/lib-wikipedia.test.js`: `searchTerms` ("How big is Paris?" includes `Paris`), `stripSnippet`, `splitSections`
  (nested paths, the lead as section 0), `splitSentences` (decimals like `105.4`, `c.`, `St.`, footnote marks),
  `parseInfobox` against a **saved fixture** of Paris's section 0, and the question builders against `validate.js`
  (≤ 255 options, keys map back).
- `test/lib-wikipedia-run.test.js`: the step machine with fake answers: the best case (5 requests), the next part, the
  next article, a disambiguation page skipped, giving up at 12, and Stop partway through.
- `test/server.test.js`: both routes with a fake `fetchImpl`: validation errors (422), the `User-Agent` sent, a timeout
  (504), 429, a title that doesn't exist, and mock mode.
- Fixtures in `test/fixtures/wikipedia/`, captured from the live API once. No test goes to the network.
- `npm test` passes, and `npm run mock` is run by hand through each example.

## Order of work

1. `public/lib/wikipedia.js` + tests (pure, no UI)
2. `src/wikipedia.js`, the routes + tests
3. `public/lib/wikipedia-run.js` + tests
4. The page, nav, examples
5. Run the examples against the real API; tune the 0.6 / 0.8 thresholds and the step 1 candidates; note the results
   in the PR
6. README, then a PR into `develop` (`feat: add a Wikipedia answer page that finds answers with Jev`)

## Not in the first version

- Questions that need two facts or a calculation ("Is Paris bigger than London?"). Later: run two lookups and let
  code compare.
- Languages other than English.
- Tables in the article body (only the infobox is read as rows).
- Saving answers or putting them in History.

## Worth trying later

- **Skip step 1:** search with every candidate term (Wikipedia calls cost nothing), merge the results and let step 2
  pick from all of them. That's one Jev request fewer, and it can't miss because of a bad term choice. Compare it
  against the step 1 version on the examples.
- **Two-stage parts for long articles** (as in TypeSafe's skill-suggestion cookbook): pick from the headings, then
  recheck the top 3 with their first sentences.

## Open questions

1. **Keep the answers?** Nothing is saved in v1. A short list of recent questions in local storage would be cheap.
2. **Quick answers from the snippet:** show them (as planned), or only ever show an answer checked in step 5?
3. **English only,** or a language picker (the API is the same on `xx.wikipedia.org`)?
