import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { CodexClient, CodexRpcError } from '../lib/codex.mjs';

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-tg-test-'));
  const socketPath = path.join(directory, 'server.sock');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const clients = new Set();
  wss.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data);
      if (message.method === 'initialize') {
        assert.equal(message.params.capabilities.experimentalApi, true);
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }));
      } else if (message.method !== 'initialized') handler(socket, message);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(async () => {
    await Promise.all([...clients].map(client => client.close()));
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return () => {
    const client = new CodexClient({ socketPath, timeoutMs: 500 });
    clients.add(client);
    return client;
  };
}

test('multiplexes responses and distinguishes a server request with the same id', async t => {
  let first;
  let receiveResponse;
  const serverResponse = new Promise(resolve => { receiveResponse = resolve; });
  const makeClient = await fixture(t, (socket, message) => {
    if (!message.method) { receiveResponse(message); return; }
    if (message.method === 'first') { first = message; return; }
    if (message.method === 'second') {
      socket.send(JSON.stringify({ id: first.id, method: 'item/tool/call', params: { tool: 'send_file' } }));
      socket.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'a', status: { type: 'active' } } }));
      socket.send(JSON.stringify({ id: message.id, result: 'second result' }));
      socket.send(JSON.stringify({ id: first.id, result: 'first result' }));
    }
  });
  const client = makeClient();
  await Promise.all([client.connect(), client.connect()]);
  const event = once(client, 'notification');
  client.on('request', request => client.respond(request.id, { success: true, contentItems: [] }));
  assert.deepEqual(await Promise.all([client.request('first'), client.request('second')]), ['first result', 'second result']);
  assert.equal((await event)[0], 'thread/status/changed');
  assert.deepEqual((await serverResponse).result, { success: true, contentItems: [] });
});

test('reports RPC errors and does not retry a timed-out mutation', async t => {
  let mutationCount = 0;
  const makeClient = await fixture(t, (socket, message) => {
    if (message.method === 'turn/start') { mutationCount++; return; }
    socket.send(JSON.stringify({ id: message.id, error: { code: -32602, message: 'Invalid params', data: { field: 'threadId' } } }));
  });
  const client = makeClient();
  await client.connect();
  await assert.rejects(client.request('thread/read'), error => error instanceof CodexRpcError && error.code === -32602 && error.data.field === 'threadId');
  await assert.rejects(client.request('turn/start', {}, { timeoutMs: 25 }), { code: 'CODEX_REQUEST_TIMEOUT', method: 'turn/start' });
  assert.equal(mutationCount, 1);
});

test('disconnect rejects pending calls and the same client can reconnect', async t => {
  const makeClient = await fixture(t, (socket, message) => {
    if (message.method === 'disconnect') socket.terminate();
    else socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
  });
  const client = makeClient();
  await client.connect();
  const disconnected = once(client, 'disconnect');
  await assert.rejects(client.request('disconnect'), /connection closed/);
  assert.equal((await disconnected)[0].intentional, false);
  assert.equal(client.connected, false);
  await client.connect();
  assert.deepEqual(await client.request('model/list'), { data: [] });
  const closed = once(client, 'disconnect');
  await client.close();
  assert.equal((await closed)[0].intentional, true);
  await assert.rejects(client.request('model/list'), /not connected/);
});

test('invalid daemon messages close the connection without exposing their content', async t => {
  const makeClient = await fixture(t, socket => socket.send('not JSON: hidden sensitive text'));
  const client = makeClient();
  await client.connect();
  await assert.rejects(client.request('bad-frame'), error => error.message === 'Codex sent an invalid JSON-RPC message');
});
