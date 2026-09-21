# Jev Studio

A local, point-and-click UI for [Jev](https://docs.typesafe.ai/introduction.md), TypeSafe's System One model.
Instead of hand-writing JSON, you paste some input, build questions with forms, and read the answers as
probability bars. Everything runs on your machine, and your API key is stored encrypted on it.

## Download

Get the app for your system from the [latest release](https://github.com/SwiftFaze/Jev-Studio/releases/latest). There
is nothing to install and no Node needed; each download is one self-contained program.

| System | File | Run it |
| --- | --- | --- |
| Windows (x64) | `jev-studio-windows-x64.exe` | Double-click. SmartScreen may warn about an unknown publisher: *More info*, then *Run anyway*. |
| macOS (Apple silicon) | `jev-studio-macos-arm64.tar.gz` | Unpack, then right-click the file and choose *Open* the first time. |
| macOS (Intel) | `jev-studio-macos-x64.tar.gz` | Same. |
| Linux (x64 / arm64) | `jev-studio-linux-x64.tar.gz`, `jev-studio-linux-arm64.tar.gz` | `tar xzf` it, then `./jev-studio-linux-x64`. |

It starts a small local server, opens Jev Studio in your default browser, and keeps a console window open while it
runs. Close that window to quit. Start it again and it just reopens the running one. The builds are not code-signed,
so Windows and macOS warn on first run; each download has a `.sha256` file to check it against.

## What it does

The pages are in the side menu. The title and **New query** stay pinned at the top, and the Ask button stays on the
bottom edge of the window, so neither scrolls away on a long page (on a phone the menu slides in from the left).

Question pages read top to bottom: the **context** box, then the **questions**, then the **answers**. The Answers panel
only appears once there is something to show.

| Page | For | Highlights |
| --- | --- | --- |
| **Single** | One query at a time, any mix of question types | Optional context, answer bars, *Copy as text*, *Compare with previous run* |
| **Yes / No** | Statements to rate true or false | Same as Single, but every question is Yes / No, so there is nothing to switch |
| **Score** | Rating along an ordered scale | Every question is a Score, with its own examples |
| **Choice** | Picking one option from a set | Every question is a Choice, with its own examples |
| **Batch** | Many items, same questions | Its own questions (separate from Single), paste lines or load a CSV, review flags with auto check-off, composite score with weights, accuracy check, CSV export; two examples in the menu |
| **Rank** | Order candidates for a query | Batch engine with fixed relevance questions and adjustable weights; an example (88 foods ranked by "Could this be used as an effective weapon?") is in the examples menu |
| **Steam reviews** (under *Tools*) | What players say about a game | Paste a store link; Jev reads its reviews a batch at a time and answers fixed questions about each: positive, worth the price, pay to win, performance, bugs and crashes, lasting appeal |
| **Compare** | See what changed between two runs | Side-by-side probabilities and deltas, notes when wording or options changed |

- **Question types**, matching the API: **Choice** (pick one option), **Yes / No** (a "noul": probability a statement
  is true) and **Score** (position on an ordered scale). The Yes / No, Score and Choice pages each keep their own input
  and questions, so switching pages never overwrites another. Runs from them go into History and restore onto the
  page they came from; *Compare with previous run* compares against the last run on the same page.
- **The input is optional.** Leave it empty for self-contained questions; an empty box sends `state: ""`.
- **New query** starts over: it clears the context, the questions (back to one empty card) and the answers. If your
  questions have any text it asks first, because they are not saved anywhere unless you put them in a Question set. Runs
  stay in History. On a question-set page and on Rank, where the questions are fixed, it clears only the context or
  query and the answers.
- **Question advice** appears under each question (one narrow judgment per question, an "other" option, concrete
  score levels). It is a suggestion and never blocks a run.
- **Question sets** are pages of their own. The **Save** button in the bottom bar (on Single, Yes / No, Score, Choice
  and Batch) asks for a **Title** and a **Description**, and saves the questions on that page as a set, listed under
  *Question sets* in the menu. The description is what to paste, for example "Paste the contents of your article and
  they will be tested for bias", and is shown above the set page's context box. Saving under a title that already exists
  says so and the button becomes **Overwrite**; nothing is replaced by accident, and questions that would fail when run
  are refused with the reason. Opening a set shows only that context box, which fills the height of the window: you
  paste, press Ask, and the page scrolls to the answers. The questions are fixed and hidden there. **Manage sets…**
  has **Edit** (it puts a set's questions back on the page it was saved from, so a set saved from Batch opens in Batch
  and every other set in Single), **Export**, **Delete** and import. The context you last pasted on each set is
  remembered.
- **History:** your last 25 runs from the question pages, searchable. **Examples** to start from (per page; there is no
  "start blank", use New query). **Token counter** for this tab.
- **API key** is entered in the app once and kept encrypted on your computer (see below).
- **Mock mode** to explore without an API key.
- Every page is the same width.

### Steam reviews in detail

It is under **Tools** in the menu. Paste a store link such as `https://store.steampowered.com/app/548430/Deep_Rock_Galactic/`
(the reviews API link and a bare app id work too). As soon as it is valid the page asks Steam how many reviews the game
has and shows that and Steam's own rating; this is free and uses no key. Reviews are always read in every language.

- **Every review, a batch at a time.** A popular game has hundreds of thousands of reviews (Deep Rock Galactic has about
  380,000), which is far more than a browser can hold, so they are never loaded together. **Analyse first batch** reads
  the first batch from Steam (you choose **50, 100, 200 or 500**, and **most recent** or **most helpful**) and asks Jev
  about each review; **Analyse next batch** reads the next one, starting exactly where the last stopped. Stopping loses
  nothing: the next press carries on from the same place, even after closing the tab. Changing the link or the sort
  starts over, and asks first.
- **Analyse more…** opens a popup with a **slider for how much of the game to have analysed**, as a percentage of its
  reviews (in steps of a tenth of a percent for a big game), with jump-to buttons for 1%, 5%, 10%, 25%, 50% and 100%. Under
  it, live, is what that costs: how many more reviews and requests, roughly how many tokens, and about how long at the
  speed so far. Nothing is spent until you press its button. It then runs batch after batch until it gets there (the last
  batch is cut short, so it stops at the chosen share and not past it), and you can press **Stop** at any time.
- **It costs what it costs.** By default Jev is asked all twenty-four questions about each review, in a separate request
  per review, and the questions are most of the cost: a first guess is about 3,200 tokens a review, and after the first
  20 reviews the page uses what they actually cost. The popup shows the estimate for whatever you pick, and warns above
  100 million tokens. All of a 380,000-review game is on the order of a billion tokens, so pick a share and stop when the
  numbers have settled, or use the two switches below to make it cheaper.
- **Questions Jev is asked** is a fold-out under the link with a **checkbox for every question**, a heading checkbox for
  each group, and presets (**All**, **The six basics**, **None**). Only the ticked questions are sent, so fewer questions
  means fewer tokens (the six basics are about 1,200 tokens a review, against about 3,200 for all of them), and the line
  above it shows the cost as you tick. The cards only cover questions that were on when a review was read, so switching one
  on later covers the reviews read from then on. *Performance by platform* needs *Runs badly* and reviews read one by one,
  so it is greyed out without it.
- **Group reviews** is a checkbox with a group size (**25, 50 or 100**). Instead of one request per review, Jev gets a
  whole group of reviews in one request and is asked what share of the group says each thing, which is about **30 times
  cheaper** (roughly 110 tokens a review at 50 to a group, against about 3,200). The trade-offs, all shown on the page:
  the cards are **estimates, marked ≈**, in their own section ("Estimated from groups of reviews"); there is **no table**
  for reviews read this way, and no filtering by count; Steam's thumbs cannot be compared with Jev's reading, so there is
  no accuracy check on them; and the shares are bands, not counts. You can mix the two in one analysis (say a cheap
  survey of the first 10,000 reviews, then one by one for a few hundred): the exact cards and the estimates are shown
  separately and never added together, and Save and Continue keep both. A batch of groups is over in seconds, so its
  progress is the running total ("Estimated from 56,109 reviews read in 562 groups, 74% of the 75,839 on Steam") in the
  bottom bar and the batch card, and the bar is the share of the game, instead of a count of the batch's own groups.
- **What is kept.** Only the batch on screen keeps its reviews. A finished batch is reduced to counts, which is all the
  summary needs and is tiny, so there is no limit on how many batches you can read. Results are kept in your browser,
  not in History.
- **The questions** (all of them on by default), in groups. *Overall:* positive, worth the price, pay to win. *Gameplay:*
  difficulty, learning curve, multiplayer and matchmaking, fun with friends, AI quality, controls and UI. *Content and value:* lasting
  appeal, story and writing, DLC and season passes, microtransactions, AI slop (generative-AI art, voice or writing,
  as opposed to the AI inside the game), length. *Technical:* performance, bugs and crashes, lost progress,
  netcode and servers, and which platform the reviewer plays on. *Community and support:* developer responsiveness,
  community, customer support. *Compared with others:* against the predecessor or similar games. Each is a Choice with
  the sides a review can take (a topic can have more than two: too easy, too hard or well balanced) and *not
  mentioned*, because most reviews say nothing about most topics.
- **2. What reviewers say** adds up every batch read so far, and says how much of the game that is. The cards are
  grouped under those headings. Each card's big number is the share for the thing in its title, so "Pay to win: 0%"
  means nobody says it is. Cards are **green** when that is good for the game (a low pay to win, a high worth the
  price), **amber** when mixed and **red** when bad. A review that does not mention a topic is left out of that topic's
  percentage, and a topic that **fewer than 10 reviews mention gets no card at all**, because a handful of reviews can
  read as 100% by chance; a line says how many topics are still missing. So cards appear as the run goes, and a
  heading with nothing under it is not drawn. *Performance by platform* pairs the platform a review says it plays on
  (Steam Deck, Linux, macOS, Nvidia, AMD, Intel) with whether it says the game runs well, one row per platform with
  enough to go on.
- **Progress** is a bar pinned in the bottom bar, right of Stop, while a run is going: the batch you are on. The totals
  so far are under the link.
- **3. This batch** covers the batch on screen: its count and tokens, an **Overview** of the answers, and a **Settings**
  group (closed) holding Review flags, Composite score and the Accuracy check. **Export CSV** is for this batch. The
  card folds shut from its header, which still shows how far the batch has got.
- **4. The reviews in this batch** is a card of its own, **closed** until you open it, with the table **25 to a page**.
  Sorting or filtering goes back to page 1. Both cards remember whether you left them open. The table shows the overall
  positive answer as its one answer column (a column for every question would not fit); open a review to see every answer, and sort by any.
- **Filtering the table.** The **Show** menu above the table lists every answer a review can have, grouped by topic
  ("Community: Friendly, Toxic", "Developer responsiveness: Responsive, Unresponsive", and so on), each with how many
  reviews in the batch gave it; answers nobody gave are left out. Picking one shows only those reviews, the same as
  clicking a count on a card, and either way the menu and the bar above the table show what it is filtered by.
  **Sort by** is deliberately short (original order, review text, review flags, certainty, composite score, and the
  answer in the column that is shown): the certainty sort already covers every question, so there is not one per question.
- **Click a count to see those reviews.** On each card the counts are clickable ("Pay to win: 26"): it opens the table,
  scrolls to it and shows only the reviews that gave that answer, with a bar above the table saying what it is filtered
  by and a **Clear filter** button. The table holds the batch on screen and no more (earlier batches were reduced to
  counts), so when a count covers more than one batch the bar says so.
- **Saved analyses.** **Save…** in the bottom bar keeps the analysis so far (asks for a title and an optional note; a
  title that exists becomes *Overwrite*). Each one appears under **Steam reviews** in the menu, as a page with the same
  cards and the **table of the batch it was saved with**, filterable in the same ways. **Continue analysis** and
  **Delete** are in the bottom bar there, as the run buttons are on the Steam reviews page. Continue puts the analysis
  back on the Steam reviews page, table included, to carry on from the same place.
  The small record (counts, and where the next batch starts) is kept in local storage, a few kilobytes however many
  reviews it covers; it also records which questions were on and whether grouping was, and Continue puts those back. A
  saved analysis that used groups shows the estimates and no table for those reviews.
  The batch's reviews are about 4 KB each, so they are kept in the browser's own database
  (IndexedDB), which has room for them; a mark you make on a saved batch is kept with it. If a browser will not keep the
  reviews the analysis is still saved, as counts only, and says so.
- **Accuracy check:** Steam's thumbs up or down is supplied as the expected answer for the positive question, so you see
  how often Jev's reading of the text agrees with the reviewer's own vote. Jev is never shown the thumbs, or the check
  would mean nothing.
- Everything else is the Batch engine: Stop and Resume, review flags, sorting. The questions are fixed, as on Rank.
  Reviews are cleaned of Steam's markup and cut at 3000 characters. Reading reviews needs no API key, and it also works in
  mock mode, where only Jev's answers are fake.

### Batch and Rank in detail

- **Load a CSV** and pick the text column. Columns named `expected_<question_id>` (for example `expected_department`)
  are your own answers, used by the accuracy check. Line breaks inside a cell become spaces.
- **Overview** (open by default): items, answered, failed, how many need review and the average certainty, then one
  card per question showing the spread of answers across all items (Yes vs No, how often each option won, or how many
  items landed on each score level).
- **The option panels start collapsed** (Review flags, Composite score / Ranking weights, Accuracy check). Each shows a
  one-line headline while closed, such as "8 of 8 need review at 50%", and remembers whether you opened it.
- **Sorting:** use the *Sort by* menu (original order, item text, number of review flags, certainty, composite score,
  or any question's answer or certainty) with the direction button, or click any column header. Sortable headers show
  ⇅. A Yes / No column shows the chance of yes, so a sorted column reads as a smooth run of numbers.
- **Review flags:** an item is flagged when any answer is less certain than the slider. Yes / No certainty is the
  distance from 50/50; Choice and Score use Jev's confidence. The panel shows how many items each threshold flags.
- **Auto check-off** (a tick box in Review flags, off by default): answers at least as certain as the slider are checked
  off for you, shown as a faded ✓, so what is left to look at is exactly what the flags point at. Move the slider and it
  changes live; it makes no API calls. The choice carries over to your next run. It is **not** counted in the accuracy
  numbers, because approving an answer for being confident is not evidence that Jev was right. Click a ✓ or ✗ yourself
  (or supply expected answers) and that answer counts. *Clear marks* removes only your own marks.
- **Batch has its own questions**, separate from the Single page. The first time it starts from a copy of Single's;
  after that editing one never changes the other, and **New query** on Batch clears only Batch's. The Batch examples
  (support tickets with expected answers, product reviews) bring their questions with them.
- **Accuracy check:** mark answers ✓ / ✗ in the table, or supply expected answers in the CSV. You get agreement by
  certainty band and how accurate the answers *you would keep* are at your current threshold. Small samples flatter any
  threshold, so treat the suggestion as a starting point and check it on your own data.
- **Composite score** (on by default): turn several answers into one 0-100 score with weights. Changing weights
  re-sorts instantly and makes no API calls. Untick it to hide the column.
- **Runs:** three requests at a time by default (1-6). Runs over 20 items ask before spending your key. A bad key or
  invalid questions stop the batch early instead of failing every item. *Stop* and *Resume / retry failed* are there.
  The last batch and rank results are kept in your browser; **New query** clears them (with a confirmation).
- **Export CSV:** every answer, per-option probabilities, review flags, composite score and agreement. Text that could
  run as a spreadsheet formula is neutralised in the file.

## Run it from source

Requires Node 22.9+ (24 recommended). Running from source needs no `npm install`; only building the executable does.

```sh
npm start                 # http://localhost:3000
```

Then add your key under **API key…** in the menu, or run `npm run mock` to explore with sample data.

| Command | What it does |
| --- | --- |
| `npm start` | Run the server; open http://localhost:3000 yourself |
| `npm run dev` | Same, restarting when server files change |
| `npm run mock` | Sample data, no key needed |
| `npm test` | Run the tests (`node --test`) |
| `npm ci && npm run build` | Build the executable for your OS into `dist/` (needs `npm ci`: esbuild and postject) |
| `node scripts/smoke.mjs dist/<file>` | Start a built executable and check it end to end |

`PORT` (default `3000`) and `TYPESAFE_API_URL` (override the endpoint) are optional environment variables. The packaged
app also takes `--mock` and `--no-open` (don't open the browser).

### Where the API key comes from

In order: the key saved in the app, then `TYPESAFE_API_KEY` from a `.env` file in the project folder (source runs
only; it beats a same-named system variable, even when empty), then `TYPESAFE_API_KEY` from your environment. The
status pill's tooltip says which one is in use.

### Entering a key in the app

**API key…** opens a dialog with a masked input. Paste your key (a pasted `Bearer ` prefix is dropped) and press Save.

- The app **encrypts it and stores it in its data folder**, so you enter it once:
  Windows `%APPDATA%\Jev Studio\apikey.enc`, macOS `~/Library/Application Support/Jev Studio/apikey.enc`,
  Linux `~/.config/jev-studio/apikey.enc`.
- The file is **AES-256-GCM**. The encryption key is derived (scrypt, random salt per save) from this machine's ID and
  your OS user name, so the file cannot be decrypted if it is copied to another computer or account. It does **not**
  protect against other programs running as you on this machine: without an OS keychain nothing in your own account can
  be kept apart from the app. If the file cannot be decrypted (for example after moving it), the app says so and you
  paste the key again.
- After you press Save the key lives only in the local server. The page never holds it again, so it is not in
  `localStorage`, history, drafts, saved sets or exports. It is never logged and never returned by any request; the app
  only reports a masked hint (`ts_••••cdef`).
- **Remove key** deletes the file. A key that an earlier version kept in the browser is moved into the encrypted file
  the first time you open the new version, then deleted from the browser.
- If TypeSafe rejects the saved key, the error points you back at the dialog.
- With `--mock` no key is used.

## How it works

```
browser tab  ->  http://localhost:3000/api/run  ->  local server (src/)  ->  https://api.typesafe.ai/v1/systemone
```

- `public/lib/`: the logic, with no DOM so it is unit-tested: CSV, batch runner, review flags, accuracy, composite
  scoring, linter, compare, question sets, export.
- `public/ui/`: the screens for each mode. Vanilla ES modules, no build step.
- `public/request.js`: converts between the editor and the API request shape.
- `src/server.js`: serves the UI and proxies `/api/run`, and saves or removes the key (`/api/key`).
- `src/keystore.js`: the encrypted key file.
- `src/validate.js`: checks requests against the documented limits (2-255 choice options, 2-10 score levels, and so on)
  and returns readable errors before any API call is made.
- `src/typesafe.js`: the upstream call; retries 429/529 with exponential backoff, as the API docs recommend.
- `src/cli.js`: the entry point: starts the server and opens the browser.
- `scripts/build.mjs`: bundles `src/` with esbuild, embeds it and all of `public/` in a
  [Node single executable](https://nodejs.org/api/single-executable-applications.html), and injects that into a copy of
  `node` with postject. Run once per OS; the release workflow does this on a runner for each.

### Security notes

The server handles your API key, so it only listens on `127.0.0.1`, rejects requests whose `Host` isn't localhost
(DNS rebinding), requires `Content-Type: application/json` on `/api/run` and saving a key (blocks cross-site form
posts; `DELETE /api/key` needs a cross-origin preflight, which the server never grants), and sends a strict
Content-Security-Policy. History, drafts, question sets and batch results are stored in your browser only.

The page cannot call Steam itself under that policy, so `POST /api/steam/reviews` (JSON only, like `/api/run`) does it.
Only the numeric app id from a pasted link is used to build the Steam request, so a link is never fetched as typed, and
your TypeSafe key is never sent to Steam. Reviewers' names and profiles are not passed on to the page. The one other
thing a request can carry, the cursor that says where the next batch starts, is only accepted if it looks like Steam's.

TypeSafe's API does not allow browser requests from other origins (it answers a CORS preflight with
`Disallowed CORS origin`), so this app can't be a static page on GitHub Pages; it needs the local server.

## Contributing and releases

- **Branches:** work on a branch, open a pull request into **`develop`**. `master` only ever receives `develop`.
- **Pull requests into `develop`** must pass CI (tests, plus a build and smoke test on Linux, Windows and macOS) and have a
  [Conventional Commit](https://www.conventionalcommits.org/) title (`feat: …`, `fix(ui): …`, `chore: …`). They are then
  **squash-merged automatically** and the branch is deleted. The PR title becomes the commit message.
- **`develop` into `master`** is a normal pull request (merge commit), and a check refuses any other source branch. Nothing
  can be pushed to `master` or `develop` directly.
- **Releases:** [release-please](https://github.com/googleapis/release-please) keeps a "release" pull request open on
  `develop`, with the next version and changelog worked out from the commit titles (`feat` = minor, `fix` = patch, `!` or
  `BREAKING CHANGE` = major; below 1.0 breaking changes bump the minor). Merging it tags the release and builds the
  Windows, macOS (Apple silicon and Intel) and Linux (x64 and arm64) downloads onto it.

### The release token

Merges and release PRs made with GitHub's built-in token do not start other workflows (a GitHub rule), so CI and the
release build would never run on them. Two workflows therefore use a personal access token stored as the repository
secret `RELEASE_PLEASE_TOKEN`: auto-merge (so the merge into `develop` starts the Release workflow) and release-please
(so CI runs on its release PR).

1. Create a **fine-grained** token (GitHub, Settings, Developer settings): repository access **Only select
   repositories** with this repo chosen, and permissions **Contents: read and write**, **Pull requests: read and write**
   (Metadata: read is added for you). A classic token with the `repo` scope also works.
2. Store it from a normal terminal, where it prompts for the value: `gh secret set RELEASE_PLEASE_TOKEN --repo SwiftFaze/Jev-Studio`
   (or Settings, Secrets and variables, Actions). Running that through a tool without a terminal can save an empty value.
3. If it is missing or too weak, PRs still auto-merge (with the built-in token) but nothing runs after the merge; the
   auto-merge job then prints what the token can see, to show what to fix.

## Reading the numbers

- **Yes / No:** probability of *yes*. Near 50% means yes and no are about equally likely, not "medium".
- **Choice / Score confidence:** how concentrated the probability is. It is not a guarantee the answer is correct;
  validate on your own data before deciding thresholds. See the [confidence docs](https://docs.typesafe.ai/confidence.md).
- **Score:** probability-weighted, so it can fall between levels.
