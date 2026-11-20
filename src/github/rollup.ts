// gh's statusCheckRollup, normalized for display. Pure.
// Entries are CheckRun ({ status, conclusion }) or StatusContext ({ state }).

export type CheckState = 'pass' | 'fail' | 'pending' | 'skip' | 'neutral';

export interface RollupEntry {
  __typename?: string;
  name?: string; context?: string; workflowName?: string;
  status?: string; conclusion?: string; state?: string;
  detailsUrl?: string; targetUrl?: string; startedAt?: string; completedAt?: string;
}

export interface CheckRun { name: string; workflow: string; state: CheckState; url: string; seconds: number | null }

const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

export function checkState(e: RollupEntry): CheckState {
  if (e.status && e.status !== 'COMPLETED') return 'pending';
  const v = (e.conclusion || e.state || '').toUpperCase();
  if (FAIL.has(v)) return 'fail';
  if (v === 'PENDING' || v === 'EXPECTED' || v === 'QUEUED' || v === 'IN_PROGRESS') return 'pending';
  if (v === 'SKIPPED') return 'skip';
  if (v === 'NEUTRAL' || v === 'STALE') return 'neutral';
  return 'pass';
}

export function checkRuns(rollup: RollupEntry[] = []): CheckRun[] {
  return rollup.map((e) => {
    const t0 = e.startedAt ? Date.parse(e.startedAt) : NaN, t1 = e.completedAt ? Date.parse(e.completedAt) : NaN;
    return {
      name: e.name || e.context || 'check',
      workflow: e.workflowName ?? '',
      state: checkState(e),
      url: e.detailsUrl || e.targetUrl || '',
      seconds: t1 > t0 ? Math.round((t1 - t0) / 1000) : null,
    };
  });
}

/** One icon for a PR row: any failure wins, then anything still running, else pass. null = no checks */
export function summarize(rollup: RollupEntry[] = []): 'pass' | 'fail' | 'pending' | null {
  if (!rollup.length) return null;
  const states = rollup.map(checkState);
  if (states.includes('fail')) return 'fail';
  if (states.includes('pending')) return 'pending';
  return 'pass';
}
