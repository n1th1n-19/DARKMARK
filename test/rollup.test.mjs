import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRuns, checkState, summarize } from '../.test-out/rollup.mjs';

test('CheckRun and StatusContext states', () => {
  assert.equal(checkState({ status: 'COMPLETED', conclusion: 'SUCCESS' }), 'pass');
  assert.equal(checkState({ status: 'IN_PROGRESS', conclusion: '' }), 'pending');
  assert.equal(checkState({ status: 'COMPLETED', conclusion: 'TIMED_OUT' }), 'fail');
  assert.equal(checkState({ status: 'COMPLETED', conclusion: 'SKIPPED' }), 'skip');
  assert.equal(checkState({ status: 'COMPLETED', conclusion: 'NEUTRAL' }), 'neutral');
  assert.equal(checkState({ __typename: 'StatusContext', state: 'PENDING' }), 'pending');
  assert.equal(checkState({ __typename: 'StatusContext', state: 'ERROR' }), 'fail');
});

test('summary: failure beats pending beats pass; neutral and skipped count as passing; none is null', () => {
  const ok = { status: 'COMPLETED', conclusion: 'SUCCESS' };
  assert.equal(summarize([]), null);
  assert.equal(summarize([ok, { status: 'COMPLETED', conclusion: 'NEUTRAL' }, { status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'pass');
  assert.equal(summarize([ok, { status: 'QUEUED' }]), 'pending');
  assert.equal(summarize([{ status: 'QUEUED' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'fail');
});

test('check runs keep name, workflow, link and duration', () => {
  const [r] = checkRuns([{ name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS',
    detailsUrl: 'https://x/1', startedAt: '2026-11-20T07:57:46Z', completedAt: '2026-11-20T07:58:15Z' }]);
  assert.deepEqual(r, { name: 'build', workflow: 'CI', state: 'pass', url: 'https://x/1', seconds: 29 });
  assert.equal(checkRuns([{ context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://y' }])[0].name, 'ci/legacy');
});
