import { fullReason, type Decision } from './decide.ts';
import type { CycleRecord } from './ledger.ts';

const escape = (value: string): string =>
  value.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  );

const stamp = (at: number | null): string =>
  at === null ? '—' : new Date(at).toISOString().replace('T', ' ').slice(0, 16);

/** Account-units, not a percentage: 0.81 across three accounts is 27% of the pool, and
 *  printing "81%" reads as four fifths of the quota still free. */
const units = (value: number): string => `${value.toFixed(2)} account-units`;

const row = (label: string, value: string): string =>
  `<tr class="noteable" id="row-${label.toLowerCase().replaceAll(' ', '-')}">` +
  `<th scope="row">${escape(label)}</th><td>${escape(value)}</td></tr>`;

const cycleRow = (cycle: CycleRecord): string =>
  `<tr class="noteable" id="cycle-${escape(cycle.startedAt)}">` +
  `<td>${escape(cycle.startedAt.slice(0, 16).replace('T', ' '))}</td>` +
  `<td>${escape(cycle.kind)}</td>` +
  `<td>${escape(cycle.exit)}</td>` +
  `<td>${cycle.yield === null ? '—' : cycle.yield.ticketsMoved + cycle.yield.prsOpened + cycle.yield.commits}</td>` +
  `<td>${cycle.asksRaised}</td></tr>`;

/**
 * Deliberately mechanical: the supervisor renders this when a cycle dies before
 * it could publish, so it must never need a model to produce.
 */
export const renderStatus = (input: {
  program: string;
  decision: Decision;
  recent: CycleRecord[];
  renderedAt: number;
  note?: string;
}): string => {
  const { program, decision, recent, renderedAt, note } = input;
  const pool = decision.pool;

  return `<aice-page>
<link rel="stylesheet" href="/_aice/tokens.css">
<script type="module" src="/_aice/widgets.js"></script>
<style>
  .drovr table { width: 100%; border-collapse: collapse; margin-block: 1rem; }
  .drovr th, .drovr td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--propra-divider, #8883); }
  .drovr .verdict { font-weight: 600; }
  .drovr footer { margin-top: 2rem; font-size: .8rem; opacity: .7; }
</style>
<article class="drovr">
  <h1 class="noteable" id="title">drovr — ${escape(program)}</h1>
  ${note === undefined ? '' : `<p class="noteable" id="note"><strong>${escape(note)}</strong></p>`}
  <table>
    <tbody>
      ${row('Verdict', decision.verdict)}
      ${row('Reason', fullReason(decision))}
      ${row('Usable accounts', pool === null ? '—' : String(pool.usableAccounts))}
      ${row('Pool fable', pool === null ? '—' : units(pool.fable))}
      ${row('Pool general', pool === null ? '—' : units(pool.general))}
      ${row('Pool session', pool === null ? '—' : units(pool.session))}
      ${row('Cycles fundable', decision.cyclesFundable === null ? '—' : decision.cyclesFundable.toFixed(2))}
      ${row('Earliest recovery', stamp(decision.earliestRecoveryAt))}
      ${row('Rendered', stamp(renderedAt))}
    </tbody>
  </table>
  <h2 class="noteable" id="recent">Recent cycles</h2>
  <table>
    <thead><tr><th>Started</th><th>Kind</th><th>Exit</th><th>Yield</th><th>Asks</th></tr></thead>
    <tbody>${recent.map(cycleRow).join('')}</tbody>
  </table>
  <footer class="noteable" id="confidential">Confidential — not for distribution</footer>
</article>
</aice-page>
`;
};
