import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary } from '../src/cli.js';
import { parkedRecord } from './fixtures.js';

test('summary exposes the listing fields', () => {
  assert.deepEqual(summary(parkedRecord()), {
    id: 'rec-1', label: 'keygen', cwd: '/work/keygen', state: 'parked', parked_at: '2026-10-02T10:00:00.000Z', tabs: 2,
  });
});
