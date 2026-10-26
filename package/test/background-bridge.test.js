const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createBridge } = require('../AIGCSelectionRefiner/js/background-bridge.js');

function get(port, resource, secret) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: resource, headers: { authorization: 'Bearer ' + secret } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

test('local resources require a separate installation token and cannot read arbitrary files', async () => {
  const bridge = createBridge({ port: 0, secret: 'a'.repeat(64) });
  await bridge.start();
  try {
    const identity = bridge.registerAsset(Buffer.from([1, 2, 3]));
    const denied = await get(bridge.port(), '/assets/' + identity, 'wrong');
    assert.equal(denied.status, 403);
    const allowed = await get(bridge.port(), '/assets/' + identity, 'a'.repeat(64));
    assert.deepEqual(allowed.body, Buffer.from([1, 2, 3]));
    const traversal = await get(bridge.port(), '/assets/../../Windows/win.ini', 'a'.repeat(64));
    assert.equal(traversal.status, 404);
    bridge.releaseAsset(identity);
    assert.equal((await get(bridge.port(), '/assets/' + identity, 'a'.repeat(64))).status, 404);
  } finally { await bridge.close(); }
});

test('unavailable helper rejects instead of running a legacy document-switching fallback', async () => {
  const bridge = createBridge({ port: 0, secret: 'b'.repeat(64), waitMs: 30 });
  await bridge.start();
  try {
    await assert.rejects(bridge.request('place', { documentId: 11 }), error => error.backgroundUnavailable === true);
  } finally { await bridge.close(); }
});

test('a closed panel server can be recreated on the same port', async () => {
  const first = createBridge({ port: 0, secret: 'c'.repeat(64) });
  await first.start();
  const port = first.port();
  await first.close();
  const second = createBridge({ port, secret: 'c'.repeat(64) });
  await second.start();
  await second.close();
});

test('a failed listener can retry once a temporarily occupied port is released', async () => {
  const occupied = http.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const bridge = createBridge({ port: occupied.address().port, secret: 'c'.repeat(64) });
  await assert.rejects(bridge.start(), error => error.backgroundUnavailable === true);
  await new Promise(resolve => occupied.close(resolve));
  try { await bridge.start(); assert.ok(bridge.port()); }
  finally { await bridge.close(); }
});

async function helper(bridge, token) {
  const socket = new WebSocket('ws://127.0.0.1:' + bridge.port() + '/connect?token=' + token, 'aigc-return-v1');
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'ready', protocol: 1, sessionId: 'original-helper-session' }));
  await bridge.waitReady();
  return socket;
}

async function snapshotFixture(currentTest, respond) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-test-snapshot-'));
  const token = '7'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, requestMs: 1000 });
  await bridge.start();
  currentTest.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const socket = await helper(bridge, token);
  socket.addEventListener('message', async event => {
    const request = JSON.parse(event.data);
    const result = await respond(request, bridge, token, socket);
    if (result) socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result }));
  });
  return { bridge, output: path.join(directory, 'snapshot.rgba'), context: { documentId: 42,
    source: { width: 10000, height: 8000, backgroundSessionId: 'original-helper-session' },
    historyStamp: '2:selection', selection: { left: 2, top: 3, width: 3000, height: 2000 } } };
}

async function uploadSnapshot(bridge, identity, token, bytes) {
  const response = await fetch('http://127.0.0.1:' + bridge.port() + '/captures/' + identity,
    { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: bytes });
  return response.status;
}

test('snapshot transport binds source identity, requires authentication and expires after completion', async currentTest => {
  let identity;
  const current = await snapshotFixture(currentTest, async (request, bridge, token) => {
    assert.equal(request.method, 'snapshot');
    assert.equal(request.args.documentId, 42);
    assert.equal(request.args.source.backgroundSessionId, 'original-helper-session');
    assert.equal(request.args.selection.width, 3000);
    identity = request.args.upload;
    assert.equal(await uploadSnapshot(bridge, identity, 'wrong', Buffer.alloc(16)), 403);
    assert.equal(await uploadSnapshot(bridge, identity, token, Buffer.alloc(16, 123)), 200);
    return { width: 2, height: 2, bounds: { left: 2, top: 3, width: 3000, height: 2000 } };
  });
  const result = await current.bridge.snapshot(current.context, current.output);
  assert.equal(result.path, current.output);
  assert.deepEqual(fs.readFileSync(current.output), Buffer.alloc(16, 123));
  assert.equal(await uploadSnapshot(current.bridge, identity, '7'.repeat(64), Buffer.alloc(16)), 404);
});

test('partial snapshots fail instead of submitting a blank or incomplete image', async currentTest => {
  const current = await snapshotFixture(currentTest, async (request, bridge, token) => {
    assert.equal(await uploadSnapshot(bridge, request.args.upload, token, Buffer.alloc(12)), 200);
    return { width: 2, height: 2 };
  });
  await assert.rejects(current.bridge.snapshot(current.context, current.output), /不完整/);
});

test('oversized snapshot dimensions are rejected even when a helper acknowledges', async currentTest => {
  const current = await snapshotFixture(currentTest, async () => ({ width: 2049, height: 1 }));
  await assert.rejects(current.bridge.snapshot(current.context, current.output), /不完整/);
});

test('closing during snapshot transport rejects the pending read instead of submitting', async currentTest => {
  const current = await snapshotFixture(currentTest, async (request, bridge) => { await bridge.close(); });
  await assert.rejects(current.bridge.snapshot(current.context, current.output), error => error.backgroundUnavailable === true);
  assert.equal(fs.existsSync(current.output), false);
});

test('Photoshop error metadata survives the bridge without being confused with a disconnected helper', async () => {
  const token = '9'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, requestMs: 1000 });
  await bridge.start();
  try {
    const socket = await helper(bridge, token);
    socket.addEventListener('message', event => {
      const request = JSON.parse(event.data);
      socket.send(JSON.stringify({ type: 'response', id: request.id, ok: false, error: 'Photoshop Error. Code: -1',
        retryable: true, number: -1, phase: 'putPixels', stripe: 1, recoveryBlocked: false }));
    });
    await assert.rejects(bridge.request('place', {}), error => error.retryable === true && error.number === -1 &&
      error.phase === 'putPixels' && error.stripe === 1 && !error.backgroundUnavailable);
  } finally { await bridge.close(); }
});

test('authenticated websocket request receives an acknowledgement and explicit document ID', async () => {
  const token = 'd'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, requestMs: 1000 });
  await bridge.start();
  try {
    const socket = await helper(bridge, token);
    assert.equal(bridge.sessionId(), 'original-helper-session');
    socket.addEventListener('message', event => {
      const request = JSON.parse(event.data);
      assert.equal(request.args.documentId, 11);
      assert.ok(request.deadline > Date.now());
      socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { placed: true } }));
    });
    assert.deepEqual(await bridge.request('place', { documentId: 11 }), { placed: true });
  } finally { await bridge.close(); }
});

test('native compatibility diagnostics survive the helper response without replacing the original error', async () => {
  const token = 'b'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token });
  await bridge.start();
  try {
    const socket = await helper(bridge, token);
    socket.addEventListener('message', event => {
      const request = JSON.parse(event.data);
      socket.send(JSON.stringify({ type: 'response', id: request.id, ok: false,
        error: 'original RGBA failure', code: -1, phase: 'putPixels',
        compatibilityError: 'mask failed', compatibilityPhase: 'putAlphaMask' }));
    });
    await assert.rejects(bridge.request('place', {}), error => error.message === 'original RGBA failure' &&
      error.code === -1 && error.phase === 'putPixels' && error.compatibilityError === 'mask failed' &&
      error.compatibilityPhase === 'putAlphaMask');
  } finally { await bridge.close(); }
});

test('closing a panel rejects in-flight requests and connection waiters immediately', async () => {
  const token = 'e'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, waitMs: 10000, requestMs: 10000 });
  await bridge.start();
  const socket = await helper(bridge, token);
  const incoming = once(socket, 'message');
  const request = bridge.request('place', { documentId: 11 });
  const rejected = assert.rejects(request, error => error.backgroundUnavailable === true);
  await incoming;
  await bridge.close();
  await rejected;
  const second = createBridge({ port: 0, secret: token, waitMs: 10000 });
  await second.start();
  const waiter = second.waitReady();
  const waiterRejected = assert.rejects(waiter, error => error.backgroundUnavailable === true);
  await new Promise(resolve => setImmediate(resolve));
  await second.close();
  await waiterRejected;
});

test('a timed-out request is retained as an error without requiring a panel restart', async () => {
  const token = 'f'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, requestMs: 30 });
  await bridge.start();
  try {
    const socket = await helper(bridge, token);
    await assert.rejects(bridge.request('place', {}), error => error.backgroundUnavailable === true);
    socket.addEventListener('message', event => {
      const request = JSON.parse(event.data);
      socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: 'recovered' }));
    });
    assert.equal(await bridge.request('place', {}), 'recovered');
  } finally { await bridge.close(); }
});

test('a half-open helper is disconnected and does not block the next helper connection', async () => {
  const token = 'a'.repeat(64);
  const bridge = createBridge({ port: 0, secret: token, heartbeatMs: 15, staleMs: 80 });
  await bridge.start();
  const raw = net.connect({ host: '127.0.0.1', port: bridge.port() });
  try {
    await once(raw, 'connect');
    const closed = once(raw, 'close');
    raw.write('GET /connect?token=' + token + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: aigc-return-v1\r\n\r\n');
    await once(raw, 'data');
    const bytes = Buffer.from(JSON.stringify({ type: 'ready', protocol: 1 }));
    raw.write(Buffer.concat([Buffer.from([129, 128 + bytes.length]), Buffer.alloc(4), bytes]));
    await bridge.waitReady();
    raw.on('data', () => {});
    let timeout;
    try { await Promise.race([closed, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(Error('stale helper never disconnected')), 1500); })]); }
    finally { clearTimeout(timeout); }
    assert.equal(bridge.isReady(), false);
    await helper(bridge, token);
    assert.equal(bridge.isReady(), true);
  } finally { raw.destroy(); await bridge.close(); }
});
