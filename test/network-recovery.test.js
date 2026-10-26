const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const extension = path.join(__dirname, '../cep/AIGCSelectionRefiner');
const apiSource = fs.readFileSync(path.join(extension, 'js/api-client.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(extension, 'js/main.js'), 'utf8');

function loadApi(transport, systemTransport) {
  const delays = [];
  const context = vm.createContext({
    module: { exports: {} }, Buffer, Uint8Array, process,
    require(name) {
      if (name === './studio-catalog') return require('../cep/AIGCSelectionRefiner/js/studio-catalog');
      if ((name === 'https' || name === 'http') && transport) return transport;
      if (name === 'child_process' && systemTransport) return systemTransport;
      return require(name);
    },
    setTimeout(callback, delay) { delays.push(delay); queueMicrotask(callback); }
  });
  vm.runInContext(apiSource, context);
  return { api: context.module.exports, delays };
}

function failingTransport(code) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    request() {
      attempts += 1;
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.write = () => {};
      request.end = () => queueMicrotask(() => request.emit('error', Object.assign(Error('connection reset'), { code })));
      return request;
    }
  };
}

test('safe reads retry transient HTTP errors and return the recovered response', async () => {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    response.writeHead(attempts < 3 ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(attempts < 3 ? 'unavailable' : '{"status":"done"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const current = loadApi();
    const response = await current.api.requestBuffer(`http://127.0.0.1:${server.address().port}/task`, { method: 'GET' });
    assert.equal(response.statusCode, 200);
    assert.equal(attempts, 3);
    assert.deepEqual(current.delays, [2000, 5000]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('safe read retries are bounded and an exhausted response remains recoverable', async () => {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    response.writeHead(503);
    response.end('unavailable');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const current = loadApi();
    const client = new current.api.GatewayClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' });
    await assert.rejects(client.getTask('trace-1'), error => error.retryable === true && error.statusCode === 503);
    assert.equal(attempts, 4);
    assert.deepEqual(current.delays, [2000, 5000, 10000]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('authorization rejection is not retried or marked for automatic recovery', async () => {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1; response.writeHead(401); response.end('{"message":"invalid key"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const current = loadApi();
    const client = new current.api.GatewayClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' });
    await assert.rejects(client.getTask('trace-1'), error => error.statusCode === 401 && !error.retryable);
    assert.equal(attempts, 1);
    assert.equal(current.delays.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an ambiguous generation POST connection reset never falls back or submits again', async () => {
  const transport = failingTransport('ECONNRESET');
  const current = loadApi(transport);
  await assert.rejects(current.api.requestBuffer('https://example.invalid/create-image', { method: 'POST', body: Buffer.from('{}') }), error => error.code === 'ECONNRESET');
  assert.equal(transport.attempts, 1);
  assert.equal(current.delays.length, 0);
});

test('curl connection failures recover on safe reads and clean every transport cache directory', async () => {
  const transport = failingTransport('ECONNREFUSED');
  const directories = [];
  let attempts = 0;
  const systemTransport = { spawn(command, args) {
    attempts += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const configPath = args[1];
    directories.push(path.dirname(configPath));
    queueMicrotask(() => {
      if (attempts < 3) {
        child.stderr.emit('data', Buffer.from('curl: (7) Could not connect to server'));
        child.emit('close', 7);
        return;
      }
      const config = fs.readFileSync(configPath, 'utf8');
      const outputPath = JSON.parse(config.match(/^output = (.+)$/m)[1]);
      fs.writeFileSync(outputPath, '{"status":"done"}');
      child.stdout.emit('data', Buffer.from('200'));
      child.emit('close', 0);
    });
    return child;
  } };
  const current = loadApi(transport, systemTransport);
  const response = await current.api.requestBuffer('https://example.invalid/task', { method: 'GET' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.buffer.toString(), '{"status":"done"}');
  assert.equal(attempts, 3);
  assert.equal(transport.attempts, 3);
  assert.deepEqual(current.delays, [2000, 5000]);
  assert.ok(directories.every(directory => !fs.existsSync(directory)));
});

test('CEP POST uses a single system transport rather than ambiguous browser fallback', async () => {
  let received = 0;
  let browserRequests = 0;
  const server = http.createServer((request, response) => {
    received += 1; response.writeHead(200); response.end('{"trace_id":"one-task"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const context = vm.createContext({ module: { exports: {} }, Buffer, Uint8Array, process, setTimeout,
      XMLHttpRequest: function () { browserRequests += 1; throw Error('browser must not send generation'); },
      require(name) { return name === './studio-catalog' ? require('../cep/AIGCSelectionRefiner/js/studio-catalog') : require(name); }
    });
    vm.runInContext(apiSource, context);
    const response = await context.module.exports.requestBuffer(`http://127.0.0.1:${server.address().port}/create-image`, { method: 'POST', body: Buffer.from('{}') });
    assert.equal(response.statusCode, 200);
    assert.equal(received, 1);
    assert.equal(browserRequests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

function loadPanel() {
  const values = new Map();
  const timers = new Map();
  const listeners = {};
  let nextTimer = 0;
  const context = vm.createContext({
    require, Buffer, Uint8Array, Uint8ClampedArray,
    CSInterface: function () {},
    AIGCGateway: loadApi().api,
    AIGCSelectionFrame: require('../cep/AIGCSelectionRefiner/js/selection-frame'),
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    window: { addEventListener(name, callback) { listeners[name] = callback; } },
    AIGCLayerPlan: require('../cep/AIGCSelectionRefiner/js/layer-plan'),
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(mainSource, context);
  context.updateControls = () => {};
  context.setStatus = () => {};
  context.setLayerStatus = () => {};
  context.removeFile = () => {};
  return { panel: context, timers, listeners, async tick() {
    const first = timers.entries().next().value;
    if (!first) return;
    timers.delete(first[0]); await first[1].callback();
  } };
}

test('a saved selection download resumes in the same panel and places only once in the original PSD', async () => {
  const current = loadPanel();
  const panel = current.panel;
  let attempts = 0;
  const placements = [];
  panel.upsertPendingTask({ id: 'selection-1', traceId: 'trace-1', type: 'selection', stage: 'downloading', resultPath: 'result.png', cleanupText: false,
    context: { documentId: 42, selection: { left: 5, top: 6, width: 80, height: 90 } } });
  panel.restoreSelectionFrame = async input => input;
  panel.evalHost = async (method, args) => { placements.push([method, args[3]]); return { warnings: [] }; };
  const client = { downloadResult: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(Error('curl: (7) Could not connect'), { retryable: true });
    return 'result.png';
  } };
  panel.gatewayClient = client;
  await panel.resumePendingTasks(client);
  assert.equal(current.timers.size, 1, 'a transient error must schedule recovery without reopening');
  await current.tick();
  assert.equal(attempts, 2);
  assert.deepEqual(placements, [['placeResult', 42]]);
  assert.equal(panel.loadPendingTasks().length, 0);
  assert.equal(current.timers.size, 0);
});

test('automatic recovery ignores active selection jobs and does not unlock an active layer run', async () => {
  const current = loadPanel();
  const panel = current.panel;
  let processed = 0;
  panel.processSelectionPendingTask = async () => { processed += 1; };
  panel.upsertPendingTask({ id: 'active-selection', type: 'selection', traceId: 'trace-1', stage: 'waiting', autoResume: true });
  panel.resumingTasks['active-selection'] = true;
  panel.layerBusy = true;
  await panel.resumePendingTasks({}, true);
  assert.equal(processed, 0);
  assert.equal(panel.layerBusy, true);
});

test('permanent platform failures discard pending tasks and never schedule automatic recovery', async () => {
  const current = loadPanel();
  const panel = current.panel;
  panel.upsertPendingTask({ id: 'failed-selection', type: 'selection', traceId: 'trace-1', stage: 'waiting', context: {} });
  panel.evalHost = async () => {};
  await panel.resumePendingTasks({ getTask: async () => ({ status: 'failed', message: 'generation failed' }) });
  assert.equal(panel.loadPendingTasks().length, 0);
  assert.equal(current.timers.size, 0);
});

test('same-panel retries keep one timer during repeated outages and stop when the panel unloads', async () => {
  const current = loadPanel();
  const panel = current.panel;
  panel.upsertPendingTask({ id: 'selection-1', type: 'selection', traceId: 'trace-1', stage: 'downloading', resultPath: 'result.png', context: {} });
  const client = { downloadResult: async () => { throw Object.assign(Error('connection unavailable'), { retryable: true }); } };
  panel.gatewayClient = client;
  await panel.resumePendingTasks(client);
  assert.equal(current.timers.size, 1);
  await current.tick();
  assert.equal(current.timers.size, 1);
  current.listeners.beforeunload();
  assert.equal(current.timers.size, 0);
  assert.equal(panel.loadPendingTasks().length, 1);
});

test('overlapping recovery calls process a persisted task only once', async () => {
  const current = loadPanel();
  const panel = current.panel;
  let release;
  let placements = 0;
  panel.upsertPendingTask({ id: 'selection-1', type: 'selection', traceId: 'trace-1', stage: 'waiting', autoResume: true });
  panel.processSelectionPendingTask = () => new Promise(resolve => { release = resolve; }).then(() => {
    placements += 1;
    panel.removePendingTask('selection-1');
  });
  const first = panel.resumePendingTasks({}, true);
  await Promise.resolve();
  await panel.resumePendingTasks({}, true);
  release();
  await first;
  assert.equal(placements, 1);
  assert.equal(panel.selectionJobs, 0);
  assert.equal(current.timers.size, 0);
});

test('starting another layer run preserves files owned by an unfinished persisted run', async () => {
  const current = loadPanel();
  const panel = current.panel;
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aigc-recovery-test-'));
  const oldDirectory = path.join(directory, 'old');
  const newDirectory = path.join(directory, 'new');
  fs.mkdirSync(oldDirectory);
  const resultPath = path.join(oldDirectory, 'layer.png');
  const sourcePath = path.join(oldDirectory, 'source.png');
  fs.writeFileSync(resultPath, 'pending result');
  fs.writeFileSync(sourcePath, 'pending source');
  panel.removeFile = filePath => { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); };
  panel.os = { tmpdir: () => newDirectory };
  fs.mkdirSync(newDirectory);
  panel.lastLayerRun = { workDirectory: oldDirectory, exportInfo: { imagePath: sourcePath } };
  panel.upsertPendingTask({ id: 'layer-old', type: 'layer', traceId: 'trace-old', stage: 'prepared', workDirectory: oldDirectory,
    result: { path: resultPath }, exportInfo: { imagePath: sourcePath } });
  panel.connected = true;
  panel.gatewayClient = {};
  panel.getElement = id => ({ value: id === 'layerList' ? 'background' : '', checked: false });
  panel.getSelectedModel = () => ({});
  panel.getSelectedModelKey = () => 'image-model';
  panel.readParameterValues = () => ({});
  panel.saveSettings = () => {};
  panel.snapshotGuideMasks = () => ({ used: 0, masks: {} });
  panel.evalHost = () => new Promise(() => {});
  try {
    panel.runLayeredPsd();
    assert.equal(fs.readFileSync(resultPath, 'utf8'), 'pending result');
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'pending source');
    assert.equal(panel.loadPendingTasks().length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a newly submitted selection survives a query outage without another create-image request', async () => {
  const current = loadPanel();
  const panel = current.panel;
  let submitted = 0;
  let queried = 0;
  const returned = [];
  const fields = { prompt: { value: 'refine texture' }, cleanupText: { checked: false } };
  panel.getElement = id => fields[id];
  panel.getSelectedModelKey = () => 'image-model';
  panel.getSelectedModel = () => ({ id: 'image-model' });
  panel.readParameterValues = () => ({});
  panel.saveSettings = () => {};
  panel.prepareExportedImage = async info => info;
  panel.prepareSelectionUpload = async info => info.imagePath;
  panel.restoreSelectionFrame = async input => input;
  panel.evalHost = async (method, args) => {
    if (method === 'exportSelection') return { imagePath: 'selection.png', documentId: 123, selectionChannelName: 'snapshot', selection: { left: 10, top: 20, width: 100, height: 200 } };
    if (method === 'placeResult') returned.push(args[3]);
    return { warnings: [] };
  };
  panel.connected = true;
  panel.gatewayClient = {
    uploadSelection: async () => 'https://example.invalid/upload.png',
    createImage: async () => { submitted += 1; return 'submitted-trace'; },
    getTask: async trace => {
      assert.equal(trace, 'submitted-trace'); queried += 1;
      if (queried === 1) throw Object.assign(Error('connection unavailable'), { retryable: true });
      return { status: 'done' };
    },
    downloadResult: async () => 'result.png'
  };
  await panel.runGeneration();
  assert.equal(submitted, 1);
  assert.equal(panel.selectionJobs, 0);
  assert.equal(current.timers.size, 1);
  assert.equal(panel.loadPendingTasks()[0].context.documentId, 123);
  await current.tick();
  assert.equal(submitted, 1);
  assert.deepEqual(returned, [123]);
  assert.equal(panel.loadPendingTasks().length, 0);
});

test('a layer query outage resumes its trace and updates the live run to prevent manual duplicate retrieval', async () => {
  const current = loadPanel();
  const panel = current.panel;
  let submitted = 0;
  let queried = 0;
  const returned = [];
  const run = {
    jobs: [{ name: 'background', kind: 'background', prompt: 'background' }],
    masks: {}, targets: [], traces: [], results: [], failures: [], placed: [], warnings: [],
    taskIds: [], taskCreatedAt: [], downloadedPaths: [], imageUrl: 'source-url', workDirectory: require('node:os').tmpdir(),
    exportInfo: { documentId: 987, source: { width: 100, height: 80 } }, groupName: 'generated layers', model: {}, modelKey: 'image-model',
    parameters: {}, cleanupText: false
  };
  run.client = {
    createImage: async () => { submitted += 1; return 'layer-trace'; },
    getTask: async () => {
      queried += 1;
      if (queried === 1) throw Object.assign(Error('temporary outage'), { retryable: true });
      return { status: 'done' };
    },
    downloadResult: async () => 'raw.png'
  };
  panel.gatewayClient = run.client;
  panel.cutoutLayer = async () => ({ path: 'layer.png', healRegions: [] });
  panel.layerParameters = () => ({});
  panel.removeDirectory = () => {};
  panel.evalHost = async (method, args) => { returned.push([method, args[1]]); return { placed: ['background'], failures: [] }; };
  await panel.executeLayerRun(run);
  assert.equal(current.timers.size, 1);
  await current.tick();
  assert.equal(submitted, 1);
  assert.deepEqual(returned, [['placeLayeredResult', 987]]);
  assert.equal(run.pendingCount, 0);
  assert.equal(run.placed[0], true);
  await panel.executeLayerRun(run);
  assert.equal(submitted, 1);
  assert.equal(returned.length, 1);
});
