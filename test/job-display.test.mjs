import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleJobs } from '../src/job-display.ts';

test('terminal jobs stay in history but not in the ambient TUI panel', () => {
  const jobs = [
    { id: 1, nativeStatus: 'terminal', result: { type: 'failed' } },
    { id: 2, nativeStatus: 'running' },
    { id: 3, nativeStatus: 'completing', result: { type: 'completed' } },
    { id: 4, nativeStatus: 'terminal', result: { type: 'completed' } },
  ];
  assert.deepEqual(visibleJobs(jobs, false).map(job => job.id), [2, 3]);
  assert.deepEqual(visibleJobs(jobs, true).map(job => job.id), [1, 2, 3, 4]);
  assert.deepEqual(visibleJobs(jobs, false, 1).map(job => job.id), [2, 3, 1]);
  assert.deepEqual(visibleJobs(jobs.filter(job => job.nativeStatus === 'terminal'), false), []);
  assert.deepEqual(visibleJobs(jobs, false).map(job => job.id), [2, 3]); // Viewing history didn't change saved state.
});
