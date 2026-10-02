import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createClient, HerdrError } from '../src/herdr-client.js';

function fakeServer(handler) {
  const path = join(tmpdir(), `hsp-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i === -1) return;
      const req = JSON.parse(buf.slice(0, i));
      const reply = handler(req);
      if (reply !== undefined) sock.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(path, () => resolve({ path, close: () => { server.close(); rmSync(path, { force: true }); } })),
  );
}

test('call sends method and params and resolves with result', async () => {
  const srv = await fakeServer((req) => ({ result: { type: 'echo', method: req.method, params: req.params } }));
  try {
    const client = createClient({ socketPath: srv.path });
    const result = await client.call('workspace.list', { a: 1 });
    assert.deepEqual(result, { type: 'echo', method: 'workspace.list', params: { a: 1 } });
  } finally { srv.close(); }
});

test('call rejects with HerdrError carrying the API error code', async () => {
  const srv = await fakeServer(() => ({ error: { code: 'workspace_not_found', message: 'nope' } }));
  try {
    const client = createClient({ socketPath: srv.path });
    await assert.rejects(client.call('workspace.get', {}), (err) => err instanceof HerdrError && err.code === 'workspace_not_found');
  } finally { srv.close(); }
});

test('call times out when the server never answers', async () => {
  const srv = await fakeServer(() => undefined);
  try {
    const client = createClient({ socketPath: srv.path, timeoutMs: 100 });
    await assert.rejects(client.call('ping'), (err) => err instanceof HerdrError && err.code === 'timeout');
  } finally { srv.close(); }
});

test('createClient without a socket path names the missing variable', () => {
  assert.throws(() => createClient({ socketPath: '' }), /HERDR_SOCKET_PATH/);
});
