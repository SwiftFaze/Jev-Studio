import { h } from '../dom.js';
import { answerCard, bar, pct } from '../results.js';
import { answerLabel, certainty, levelCount } from '../lib/answers.js';
import { reviewCurve, reviewReasons, reviewSummary } from '../lib/review.js';
import { compositeScore } from '../lib/composite.js';
import { accuracyReport, collectVerdicts, countAutoChecked, isAutoChecked, markKey, suggestThreshold, verdictFor } from '../lib/accuracy.js';
import { defaultDir, sortRows } from '../lib/table.js';
import { summarizeRun } from '../lib/overview.js';
import { batchCsvRows } from '../lib/export.js';
import { toCsv } from '../lib/csv.js';
import { downloadText, fileStamp } from './download.js';

const TYPE_LABEL = { choice: 'Choice', noul: 'Yes / No', score: 'Score' };

/**
 * Build the results view for a batch or rank run and return `{ refresh }`.
 * The controls are built once; refresh() recomputes everything that depends on them (counts, table, accuracy),
 * so dragging a slider or opening the sort menu never rebuilds the control itself. `run` is mutated in place and
 * `hooks.onChange` saves it.
 */
export function renderBatchResults(root, run, hooks) {
  const ids = Object.keys(run.questions);
  const rank = run.kind === 'rank';
  const s = run.settings;
  run.marks ??= {};
  // Older runs could hold marks from "Validate all" (removed): those were approvals, not evidence, so drop them.
  if (run.bulk) {
    for (const key of Object.keys(run.bulk)) if (run.marks[key] === true) delete run.marks[key];
    delete run.bulk;
  }
  s.panels ??= {};
  const changed = () => hooks.onChange?.();

  /**
   * A collapsible section. Everything except the Overview starts closed; once you open or close one, that choice
   * is remembered (and carried into the next run). `headline` is a small live summary shown even when it is closed.
   */
  function panel(key, title, { defaultOpen = false, className = '' } = {}, ...children) {
    const headline = h('span', { class: 'panel-headline' });
    const details = h('details', { class: `bulk-panel ${className}`.trim(), open: s.panels[key] ?? defaultOpen }, h('summary', {}, h('span', {}, title), headline), ...children);
    details.addEventListener('toggle', () => {
      s.panels[key] = details.open;
      changed();
    });
    return { details, headline };
  }

  /* ---------- progress ---------- */
  const fill = h('div', { class: 'bar-fill is-winner' });
  fill.style.width = '0%';
  const progressText = h('span', { class: 'muted small' });
  const stopBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => hooks.onStop?.() }, 'Stop');
  const resumeBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => hooks.onResume?.() }, 'Resume / retry failed');
  const exportBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: exportCsv }, 'Export CSV');
  const fatalNote = h('p', { class: 'error', role: 'alert', hidden: true });

  function updateProgress() {
    const rows = run.rows;
    const ok = rows.filter((r) => r.status === 'ok').length;
    const failed = rows.filter((r) => r.status === 'error').length;
    const notRun = rows.length - ok - failed;
    const running = hooks.isRunning?.() ?? false;
    const tokens = rows.reduce((sum, r) => sum + (r.response?.usage ? r.response.usage.input_tokens + r.response.usage.output_tokens : 0), 0);

    fill.style.width = `${rows.length ? ((ok + failed) / rows.length) * 100 : 0}%`;
    progressText.textContent = [
      `${ok + failed} of ${rows.length} done`,
      failed > 0 && `${failed} failed`,
      !running && notRun > 0 && `${notRun} not run`,
      tokens > 0 && `${tokens.toLocaleString('en-US')} tokens`,
    ]
      .filter(Boolean)
      .join(' · ');
    stopBtn.hidden = !running;
    resumeBtn.hidden = running || failed + notRun === 0;
    exportBtn.disabled = ok + failed === 0;
    fatalNote.hidden = !run.fatal;
    fatalNote.textContent = run.fatal ? `Stopped early: ${run.fatal}` : '';
  }

  function exportCsv() {
    downloadText(`jev-${run.kind}-${fileStamp()}.csv`, `﻿${toCsv(batchCsvRows(run))}`, 'text/csv');
  }

  /* ---------- overview ---------- */
  const overviewBody = h('div', { class: 'overview' });
  const overview = panel('overview', 'Overview', { defaultOpen: true }, overviewBody);

  const stat = (value, label, tone = '') => h('div', { class: `stat${tone ? ` stat-${tone}` : ''}` }, h('strong', { class: 'stat-value' }, String(value)), h('span', { class: 'muted small' }, label));

  function distRow(label, n, total, { winner = false, note = '' } = {}) {
    const share = total ? n / total : 0;
    // A long label (an option or score level with a description) gets a full-width line of its own; the bar goes under it.
    const long = label.length + note.length > 24;
    return h('div', { class: `dist-row${long ? ' dist-row-long' : ''}` }, h('span', { class: 'dist-label' }, label, note && h('span', { class: 'muted small' }, ` ${note}`)), bar(share, { winner }), h('span', { class: 'dist-count small' }, `${n} · ${pct(share)}`));
  }

  function overviewCard(qs) {
    let body;
    if (qs.answered === 0) {
      body = h('p', { class: 'muted small' }, 'No answers yet.');
    } else if (qs.type === 'noul') {
      body = [distRow('Yes', qs.yes, qs.answered, { winner: qs.yes >= qs.no }), distRow('No', qs.no, qs.answered, { winner: qs.no > qs.yes }), h('p', { class: 'muted small' }, `Average chance of yes: ${pct(qs.meanYes)}`)];
    } else if (qs.type === 'choice') {
      const top = Math.max(...qs.options.map((o) => o.n));
      body = qs.options.map((o) => distRow(o.key, o.n, qs.answered, { winner: o.n === top && top > 0 }));
    } else {
      const top = Math.max(...qs.levels.map((l) => l.n));
      body = [...qs.levels.map((l) => distRow(String(l.level), l.n, qs.answered, { winner: l.n === top && top > 0, note: l.label })), h('p', { class: 'muted small' }, `Average score: ${qs.mean.toFixed(2)} of 0-${qs.levels.length - 1}`)];
    }
    return h(
      'article',
      { class: 'ov-card' },
      h('header', { class: 'a-head' }, h('h3', { class: 'mono' }, qs.id), h('span', { class: 'tag' }, TYPE_LABEL[qs.type])),
      body,
      qs.answered > 0 && h('p', { class: 'muted small' }, `${qs.answered} answered · average certainty ${pct(qs.meanCertainty ?? 0)} · ${qs.uncertain} below your review setting`),
    );
  }

  function updateOverview() {
    const sum = summarizeRun(run);
    overview.headline.textContent = sum.ok === 0 ? '' : `${sum.ok} answered · ${sum.flagged} need review`;
    if (sum.ok === 0 && sum.failed === 0) {
      overviewBody.replaceChildren(h('p', { class: 'muted' }, 'Nothing has finished yet.'));
      return;
    }
    overviewBody.replaceChildren(
      h(
        'div',
        { class: 'stat-grid' },
        stat(sum.total, sum.total === 1 ? 'item' : 'items'),
        stat(sum.ok, 'answered'),
        sum.failed > 0 && stat(sum.failed, 'failed', 'bad'),
        stat(sum.flagged, 'need review', sum.flagged > 0 ? 'warn' : 'good'),
        sum.meanCertainty != null && stat(pct(sum.meanCertainty), 'average certainty'),
      ),
      h('div', { class: 'ov-cards' }, sum.questions.map(overviewCard)),
    );
  }

  /* ---------- review flags ---------- */
  const thresholdValue = h('strong', {});
  const reviewInfo = h('div', { class: 'review-info' });
  const slider = h('input', {
    type: 'range',
    min: 0,
    max: 95,
    step: 5,
    'aria-label': 'Flag answers less certain than this',
    value: Math.round(s.minCertainty * 100),
    oninput: (e) => {
      s.minCertainty = Number(e.target.value) / 100;
      refresh();
      changed();
    },
  });
  const onlyReview = h('input', {
    type: 'checkbox',
    checked: s.onlyReview,
    onchange: (e) => {
      s.onlyReview = e.target.checked;
      refresh();
      changed();
    },
  });

  // Answers at or above the slider's certainty are checked off for you, so only the flagged ones are left to review.
  const autoBox = h('input', {
    type: 'checkbox',
    id: `${run.kind}-auto-check`,
    checked: Boolean(s.autoCheck),
    onchange: (e) => {
      s.autoCheck = e.target.checked;
      refresh();
      changed();
    },
  });
  const autoInfo = h('p', { class: 'muted small' });

  const review = panel(
    'review',
    'Review flags',
    {},
    h('p', { class: 'hint' }, "Flag an item when any answer is less certain than the slider. Yes / No certainty is distance from 50/50; Choice and Score use Jev's confidence. Pick the number from your own data."),
    h('div', { class: 'slider-row' }, h('label', {}, 'Flag answers less certain than '), slider, thresholdValue),
    reviewInfo,
    rank ? null : [h('label', { class: 'check' }, autoBox, ' Check off answers that are at least as certain as the slider, automatically'), autoInfo],
    h('label', { class: 'check' }, onlyReview, ' Show only items that need review'),
  );

  function updateReview() {
    thresholdValue.textContent = pct(s.minCertainty);
    const { done, flagged } = reviewSummary(run.rows, ids, s.minCertainty);
    const autoOn = !rank && s.autoCheck;
    const autoCount = autoOn ? countAutoChecked(run.rows, run.questions, run.marks, s.minCertainty) : 0;
    review.headline.textContent = done === 0 ? '' : `${flagged} of ${done} need review at ${pct(s.minCertainty)}${autoOn ? ' · auto check-off on' : ''}`;
    autoInfo.textContent = autoOn ? `${autoCount} answer${autoCount === 1 ? '' : 's'} checked off automatically. They do not count in the accuracy check, because being confident is not evidence of being right.` : '';
    reviewInfo.replaceChildren(
      h('p', {}, done === 0 ? 'Nothing has finished yet.' : `${flagged} of ${done} finished items need a person to look at them at this setting.`),
      h('p', { class: 'muted small' }, 'If you flag below: ', reviewCurve(run.rows, ids).map((c) => h('span', { class: 'chip-soft' }, `${pct(c.threshold)} → ${c.flagged}`))),
    );
  }

  /* ---------- composite score ---------- */
  const compositeOn = h('input', {
    type: 'checkbox',
    checked: s.compositeOn,
    onchange: (e) => {
      s.compositeOn = e.target.checked;
      if (s.compositeOn && s.sort.key === 'index') s.sort = { key: 'composite', dir: 'desc' };
      refresh();
      changed();
    },
  });

  function specRow(id) {
    const spec = run.specs[id];
    const q = run.questions[id];
    const weightLabel = h('span', { class: 'small spec-weight' }, String(spec.weight));
    const update = () => {
      refresh();
      changed();
    };

    let target = null;
    if (q.type === 'choice') {
      target = h('select', { 'aria-label': `Which option of ${id} counts`, onchange: (e) => { spec.target = e.target.value; update(); } }, Object.keys(q.criteria).map((k) => h('option', { value: k }, k)));
      target.value = spec.target ?? '';
    }

    return h(
      'div',
      { class: 'spec-row' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: spec.enabled, onchange: (e) => { spec.enabled = e.target.checked; update(); } }), ' ', h('span', { class: 'mono' }, id)),
      h('span', { class: 'tag' }, TYPE_LABEL[q.type]),
      target && h('label', { class: 'small' }, 'counts: ', target),
      h('input', {
        type: 'range', min: 0, max: 100, step: 5, 'aria-label': `Weight of ${id}`, value: spec.weight,
        oninput: (e) => { spec.weight = Number(e.target.value); weightLabel.textContent = String(spec.weight); update(); },
      }),
      weightLabel,
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: spec.invert, onchange: (e) => { spec.invert = e.target.checked; update(); } }), ' lower is better'),
    );
  }

  const composite = panel(
    'composite',
    rank ? 'Ranking weights' : 'Composite score',
    {},
    h('p', { class: 'hint' }, 'Combine the answers into one 0-100 score and rank by it. Changing weights re-sorts instantly and makes no new API calls. Yes / No counts as P(yes), Score as its position on the scale, and Choice as the probability of the option you pick.'),
    h('label', { class: 'check' }, compositeOn, rank ? ' Use this score to rank' : ' Show a composite score column'),
    h('div', { class: 'spec-list' }, ids.map(specRow)),
  );

  /* ---------- accuracy ---------- */
  const accuracyBody = h('div', { class: 'acc-body' });
  const accuracy = rank ? null : panel('accuracy', 'Accuracy check', {}, accuracyBody);

  function updateAccuracy() {
    const verdicts = collectVerdicts(run.rows, run.questions, run.marks);
    const autoCount = s.autoCheck ? countAutoChecked(run.rows, run.questions, run.marks, s.minCertainty) : 0;
    const report = accuracyReport(verdicts, s.minCertainty);
    const rate = (t) => (t.n ? pct(t.correct / t.n) : '-');
    accuracy.headline.textContent = verdicts.length === 0 ? '' : `${report.overall.correct} of ${report.overall.n} agree (${rate(report.overall)})`;

    const autoNote = autoCount > 0 ? h('p', { class: 'notice' }, `${autoCount} answer${autoCount === 1 ? ' is' : 's are'} checked off automatically (at least ${pct(s.minCertainty)} certain) and ${autoCount === 1 ? 'is' : 'are'} not counted here: being confident is not evidence that Jev was right. Tick or cross an answer yourself to count it.`) : null;

    if (verdicts.length === 0) {
      accuracyBody.replaceChildren(h('p', { class: 'hint' }, 'Mark answers right or wrong with ✓ / ✗ in the table, or import a CSV that has expected_<question_id> columns. Accuracy shows up here.'), autoNote);
      return;
    }
    const suggestion = suggestThreshold(verdicts);

    accuracyBody.replaceChildren(
      ...[
        h('p', {}, h('strong', {}, `${report.overall.correct} of ${report.overall.n} checked answers agree (${rate(report.overall)}).`)),
        h('ul', { class: 'plain-list' }, Object.entries(report.byQuestion).map(([id, t]) => h('li', {}, h('span', { class: 'mono' }, id), `: ${t.correct} of ${t.n} (${rate(t)})`))),
        h(
          'table',
          { class: 'mini-table' },
          h('thead', {}, h('tr', {}, ['Certainty', 'Answers', 'Agree', 'Accuracy'].map((c) => h('th', {}, c)))),
          h('tbody', {}, report.buckets.map((b) => h('tr', {}, h('td', {}, b.label), h('td', {}, String(b.n)), h('td', {}, b.n ? `${b.correct}/${b.n}` : '-'), h('td', {}, b.n ? h('div', { class: 'acc-cell' }, bar(b.correct / b.n, { winner: true }), h('span', { class: 'small' }, rate(b))) : '-')))),
        ),
        h('p', {}, `At your current flag setting (${pct(s.minCertainty)}): answers you would keep agree ${report.kept.correct} of ${report.kept.n} (${rate(report.kept)}); flagged ones agree ${report.flagged.correct} of ${report.flagged.n} (${rate(report.flagged)}).`),
        h('p', { class: 'muted small' }, suggestion
          ? `Lowest setting where kept answers reach 90%: ${pct(suggestion.threshold)} (keeps ${suggestion.n} of ${verdicts.length} checked answers). Small samples flatter any threshold, so check more before trusting it.`
          : 'Not enough checked answers yet to suggest a threshold (needs at least 10 answers above it, and 90% agreement).'),
        autoNote,
      ].filter(Boolean),
    );
  }

  /* ---------- sorting and validating ---------- */
  const sortChoices = [
    ['index', 'Original order'],
    ['text', rank ? 'Candidate text' : 'Item text'],
    ['flags', 'Number of review flags'],
    ['certainty', 'Certainty (lowest across questions)'],
    ['composite', rank ? 'Score' : 'Composite score'],
    ...ids.flatMap((id) => [
      [`q:${id}`, `${id}: answer`],
      [`c:${id}`, `${id}: certainty`],
    ]),
  ];
  const sortKeys = sortChoices.map(([key]) => key);

  function setSort(key, { toggle = false } = {}) {
    if (toggle && s.sort.key === key) s.sort = { key, dir: s.sort.dir === 'asc' ? 'desc' : 'asc' };
    else s.sort = { key, dir: defaultDir(key) };
    if (key === 'composite' && !s.compositeOn) {
      s.compositeOn = true; // sorting by it is pointless if you cannot see it
      compositeOn.checked = true;
    }
    refresh();
    changed();
  }

  const sortSelect = h('select', { 'aria-label': 'Sort the table by', onchange: (e) => setSort(e.target.value) }, sortChoices.map(([key, label]) => h('option', { value: key }, label)));
  const dirBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setSort(s.sort.key, { toggle: true }) });

  const visibleRows = () => (s.onlyReview ? run.rows.filter((r) => reviewReasons(r, ids, s.minCertainty).length > 0) : run.rows);

  function clearMarks() {
    if (!confirm('Remove all your ✓ / ✗ marks? Verdicts that come from expected answers in your CSV stay.')) return;
    for (const key of Object.keys(run.marks)) delete run.marks[key];
    refresh();
    changed();
  }

  const clearBtn = h('button', { type: 'button', id: `${run.kind}-clear-marks`, class: 'btn btn-ghost btn-sm', onclick: clearMarks }, 'Clear marks');

  const toolbar = h('div', { class: 'table-toolbar' }, h('label', { class: 'small toolbar-sort' }, 'Sort by ', sortSelect), dirBtn, rank ? null : clearBtn);

  function updateToolbar() {
    sortSelect.value = sortKeys.includes(s.sort.key) ? s.sort.key : 'index';
    dirBtn.textContent = s.sort.dir === 'asc' ? 'Ascending ▲' : 'Descending ▼';
    dirBtn.title = s.sort.key === 'flags' || s.sort.key === 'composite' ? 'Descending puts the most flagged / highest score first.' : 'Reverse the order.';
    if (!rank) clearBtn.hidden = Object.keys(run.marks).length === 0;
  }

  /* ---------- table ---------- */
  const tableHost = h('div', { class: 'table-wrap' });

  // Every sortable header shows a ⇅ so it is obvious it can be clicked; the active one shows its direction.
  const th = (label, key) =>
    h(
      'th',
      { 'aria-sort': s.sort.key === key ? (s.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', { type: 'button', class: 'th-btn', title: 'Click to sort', onclick: () => setSort(key, { toggle: true }) }, label, h('span', { class: `sort-ind${s.sort.key === key ? ' active' : ''}` }, s.sort.key === key ? (s.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅')),
    );

  /**
   * One ✓ or ✗. `current` is the verdict from your marks or your file's expected values; `auto` means the answer is
   * checked off automatically (shown as a faded ✓). Clicking either button judges the answer yourself, and that counts.
   */
  function markButton(row, id, value, current, auto) {
    const key = markKey(row.index, id);
    const derived = run.marks[key] === undefined && current !== null;
    return h(
      'button',
      {
        type: 'button',
        class: `mark ${value ? 'mark-yes' : 'mark-no'}${derived ? ' derived' : ''}${auto ? ' auto' : ''}`,
        'aria-pressed': String(auto ? value === true : current === value),
        'aria-label': value ? `Mark ${id} correct` : `Mark ${id} wrong`,
        title: auto
          ? `Checked off automatically: at least ${pct(s.minCertainty)} certain. Click ✓ or ✗ to judge it yourself.`
          : derived ? 'Set from the expected value in your file. Click to override.' : value ? 'Mark correct' : 'Mark wrong',
        onclick: (e) => {
          e.stopPropagation();
          if (run.marks[key] === value) delete run.marks[key];
          else run.marks[key] = value;
          refresh();
          changed();
        },
      },
      value ? '✓' : '✗',
    );
  }

  function answerCell(row, id) {
    const q = run.questions[id];
    if (row.status !== 'ok') return h('td', { class: 'cell-muted' }, row.status === 'error' ? '-' : row.status === 'running' ? '…' : '');
    const a = row.response.answers?.[id];
    if (!a) return h('td', { class: 'cell-muted' }, 'no answer');

    const c = certainty(a);
    const flagged = c != null && c < s.minCertainty;
    // Yes / No shows the chance of yes (what the column sorts by), so a sorted column reads as a smooth run of numbers.
    const detail = a.type === 'noul' ? `${pct(a.noul)} yes` : a.type === 'choice' ? pct(a.probabilities?.[a.choice] ?? 0) : `of 0-${levelCount(q) - 1}`;
    const verdict = rank ? null : verdictFor(row, q, id, run.marks);
    const auto = !rank && Boolean(s.autoCheck) && isAutoChecked(row, q, id, run.marks, s.minCertainty);

    return h(
      'td',
      { class: flagged ? 'cell cell-flag' : 'cell', title: c == null ? '' : `${pct(c)} certain${flagged ? ' (below your flag setting)' : ''}` },
      h('div', { class: 'cell-main' }, h('span', { class: 'cell-label' }, answerLabel(a)), h('span', { class: 'muted small' }, detail)),
      rank ? null : h('span', { class: 'marks' }, markButton(row, id, true, verdict, auto), markButton(row, id, false, verdict, auto)),
    );
  }

  function reviewCell(row) {
    if (row.status === 'error') return h('td', {}, h('span', { class: 'badge badge-bad', title: row.error ?? '' }, 'Failed'));
    if (row.status !== 'ok') return h('td', { class: 'cell-muted' }, row.status === 'running' ? '…' : '');
    const reasons = reviewReasons(row, ids, s.minCertainty);
    if (reasons.length === 0) return h('td', {}, h('span', { class: 'badge badge-ok' }, 'OK'));
    return h('td', {}, h('span', { class: 'badge badge-warn', title: reasons.map((r) => `${r.id}: ${r.reason}`).join('\n') }, `Review (${reasons.length})`));
  }

  function detailRow(row, columns) {
    const body = row.status === 'error'
      ? h('div', {}, h('p', { class: 'error' }, row.error ?? 'Request failed.'), h('button', { type: 'button', class: 'btn btn-sm', onclick: () => hooks.onRetryRow?.(row.index) }, 'Retry this item'))
      : row.status === 'ok'
        ? h('div', { class: 'answers' }, ids.map((id) => answerCard(id, run.questions[id], row.response.answers?.[id])))
        : h('p', { class: 'muted' }, 'Not run yet.');
    return h('tr', { class: 'detail-row' }, h('td', { colspan: String(columns) }, h('p', { class: 'detail-text' }, row.text), body));
  }

  function buildTable() {
    const rows = sortRows(visibleRows(), s.sort, { questions: run.questions, specs: run.specs, minCertainty: s.minCertainty });

    const ranked = rank && s.sort.key === 'composite' && s.sort.dir === 'desc';
    const columns = 3 + ids.length + (s.compositeOn ? 1 : 0);
    const head = h(
      'tr',
      {},
      th(ranked ? 'Rank' : '#', 'index'),
      th(rank ? 'Candidate' : 'Item', 'text'),
      ids.map((id) => th(id, `q:${id}`)),
      s.compositeOn ? th(rank ? 'Score' : 'Composite', 'composite') : null,
      th('Review', 'flags'),
    );

    const body = h('tbody', {});
    rows.forEach((row, pos) => {
      const open = run.open === row.index;
      const toggle = () => {
        run.open = open ? null : row.index;
        refresh();
      };
      const score = s.compositeOn ? compositeScore(row, run.questions, run.specs) : null;
      body.append(
        h(
          'tr',
          {
            class: `data-row${open ? ' is-open' : ''}`,
            tabindex: '0',
            'aria-expanded': String(open),
            onclick: toggle,
            onkeydown: (e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                toggle();
              }
            },
          },
          h('td', { class: 'num' }, String(ranked ? pos + 1 : row.index + 1)),
          h('td', { class: 'item-cell', title: row.text }, row.text),
          ids.map((id) => answerCell(row, id)),
          s.compositeOn ? h('td', { class: 'cell' }, score == null ? '' : h('div', { class: 'cell-main' }, h('span', { class: 'cell-label' }, String(Math.round(score * 100))), bar(score, { winner: true }))) : null,
          reviewCell(row),
        ),
      );
      if (open) body.append(detailRow(row, columns));
    });

    if (rows.length === 0) body.append(h('tr', {}, h('td', { colspan: String(columns), class: 'cell-muted' }, s.onlyReview ? 'No items need review at this setting.' : 'No items.')));
    return h('table', { class: 'results-table' }, h('thead', {}, head), body);
  }

  function updateHeadlines() {
    if (rank) composite.headline.textContent = ids.map((id) => `${id} ${run.specs[id].enabled ? run.specs[id].weight : 'off'}`).join(' · ');
    else composite.headline.textContent = s.compositeOn ? 'on' : 'off';
  }

  function refresh() {
    updateProgress();
    updateOverview();
    updateReview();
    updateHeadlines();
    if (accuracy) updateAccuracy();
    updateToolbar();
    tableHost.replaceChildren(buildTable());
  }

  root.replaceChildren(
    ...[
      h('div', { class: 'bulk-summary' }, h('div', { class: 'bulk-progress' }, h('div', { class: 'bar' }, fill), progressText), h('div', { class: 'bulk-actions' }, stopBtn, resumeBtn, exportBtn)),
      fatalNote,
      overview.details,
      review.details,
      composite.details,
      accuracy?.details,
      toolbar,
      tableHost,
    ].filter(Boolean),
  );
  refresh();
  return { refresh };
}
