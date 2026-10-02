import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexResolver, threadNameFromTitle } from '../src/codex-sessions.js';

const A = '01a0eea8-02ca-7ba2-953a-4d0f83360abe';
const B = '01a0fa33-6e3b-7000-8615-273a111ca99f';
const C = '01a0fc7e-3eeb-7f91-84b3-460d93d15abf';
const reported = (value) => ({ source: 'herdr:codex', agent: 'codex', kind: 'id', value });

function codexHome({ rollouts, index }) {
  const home = mkdtempSync(join(tmpdir(), 'hsp-codex-'));
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  for (const [id, cwd] of Object.entries(rollouts)) {
    writeFileSync(join(day, `rollout-2026-09-29T16-33-03-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n{"type":"other"}\n`);
  }
  writeFileSync(join(home, 'session_index.jsonl'), index.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return home;
}

const pane = (extra) => ({ agent: 'codex', agent_session: null, cwd: '/work/keygen', foreground_cwd: '/work/keygen', terminal_title_stripped: null, ...extra });

test('threadNameFromTitle strips the trailing directory segment', () => {
  assert.equal(threadNameFromTitle('Revisa efectos colaterales PR #351 | keygen'), 'Revisa efectos colaterales PR #351');
  assert.equal(threadNameFromTitle('chat-api'), 'chat-api');
  assert.equal(threadNameFromTitle(''), null);
  assert.equal(threadNameFromTitle(null), null);
});

test('a reported id confirmed by the title is verified', () => {
  const home = codexHome({ rollouts: { [A]: '/work/keygen' }, index: [{ id: A, thread_name: 'Fix login' }] });
  const result = createCodexResolver({ codexHome: home })(pane({ agent_session: reported(A), terminal_title_stripped: 'Fix login | keygen' }));
  assert.deepEqual(result, { ref: reported(A), method: 'verified' });
});

test('a reported id without title confirmation is not trusted, even in the same cwd', () => {
  const home = codexHome({ rollouts: { [A]: '/work/keygen' }, index: [{ id: A, thread_name: 'Fix login' }] });
  const result = createCodexResolver({ codexHome: home })(pane({ agent_session: reported(A) }));
  assert.equal(result.method, 'unresolved');
  assert.equal(result.ref, null);
});

test('a reported id that belongs to another pane in the same repo is replaced by the title match', () => {
  const home = codexHome({
    rollouts: { [A]: '/work/keygen', [B]: '/work/keygen' },
    index: [{ id: A, thread_name: 'Other work' }, { id: B, thread_name: 'Fix login' }],
  });
  const result = createCodexResolver({ codexHome: home })(pane({ agent_session: reported(A), terminal_title_stripped: 'Fix login | keygen' }));
  assert.deepEqual(result, { ref: reported(B), method: 'inferred' });
});

test('a reported id from another directory is not trusted; inference takes over', () => {
  const home = codexHome({ rollouts: { [A]: '/work/other', [B]: '/work/keygen' }, index: [{ id: B, thread_name: 'Fix login' }] });
  const result = createCodexResolver({ codexHome: home })(pane({ agent_session: reported(A), terminal_title_stripped: 'Fix login | keygen' }));
  assert.equal(result.method, 'inferred');
  assert.equal(result.ref.value, B);
});

test('a unique thread name in the same cwd is inferred; the latest rename wins', () => {
  const home = codexHome({
    rollouts: { [A]: '/work/keygen' },
    index: [{ id: A, thread_name: 'Old name' }, { id: A, thread_name: 'Revisa PR #351' }],
  });
  const result = createCodexResolver({ codexHome: home })(pane({ terminal_title_stripped: 'Revisa PR #351 | keygen' }));
  assert.deepEqual(result, { ref: reported(A), method: 'inferred' });
});

test('ambiguous names, unnamed threads and missing titles stay unresolved', () => {
  const home = codexHome({
    rollouts: { [A]: '/work/keygen', [B]: '/work/keygen', [C]: '/work/other' },
    index: [{ id: A, thread_name: 'Guardian review' }, { id: B, thread_name: 'Guardian review' }, { id: C, thread_name: 'Solo' }],
  });
  const resolve = createCodexResolver({ codexHome: home });
  assert.match(resolve(pane({ terminal_title_stripped: 'Guardian review | keygen' })).reason, /2 codex threads/);
  assert.match(resolve(pane({ terminal_title_stripped: 'Solo | keygen' })).reason, /no codex thread named "Solo"/);
  assert.match(resolve(pane({ terminal_title_stripped: 'keygen' })).reason, /no codex thread named "keygen"/);
  assert.equal(resolve(pane({})).method, 'unresolved');
});
