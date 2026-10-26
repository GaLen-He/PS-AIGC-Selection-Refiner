const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const gateway = require('../AIGCSelectionRefiner/js/api-client');
const mainSource = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8');

function harness(storage = new Map()) {
  const timers = new Map();
  const events = {};
  const reports = [];
  let timerId = 0;
  const panel = vm.createContext({ require, Buffer, Uint8Array, Uint8ClampedArray,
    CSInterface: function () {}, AIGCGateway: gateway,
    window: { addEventListener(name, callback) { events[name] = callback; } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(identity) { timers.delete(identity); }
  });
  vm.runInContext(mainSource, panel);
  panel.updateControls = () => {};
  panel.setStatus = (message, kind) => reports.push({ message, kind });
  panel.setLayerStatus = panel.setStatus;
  panel.removeFile = () => {};
  panel.fitResultToSelection = async result => result;
  panel.restoreSelectionFrame = async input => input;
  panel.cutoutLayer = async input => ({ path: input, healRegions: [] });
  return { panel, storage, timers, events, reports };
}

function task(filePath, extra = {}) {
  return { id: 'task-original', traceId: 'paid-trace-original', type: 'selection', stage: 'placing', autoResume: false,
    resultPath: filePath, result: { path: filePath, healRegions: [] }, cleanupText: false,
    context: { documentId: 42, source: { width: 100, height: 80, backgroundSessionId: 'original-session' },
      selection: { left: 10, top: 20, width: 2, height: 2 },
      slot: { layerId: 5, parentId: 42, name: 'reserved', reservationId: 'original-reservation', maskPrepared: true } }, ...extra };
}

function cachedFile(currentTest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-recovery-test-'));
  currentTest.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'result.png');
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3]));
  return filePath;
}

test('single-task retry immediately clears stale failure and never starts another paused task', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { lastRecoveryError: { message: 'old failure', phase: 'putPixels' }, recoveryExhausted: true });
  current.panel.upsertPendingTask(saved);
  current.panel.upsertPendingTask(task(saved.result.path, { id: 'other-task', lastRecoveryError: { message: 'paused' } }));
  current.panel.gatewayClient = {};
  let complete;
  const calls = [];
  current.panel.processSelectionPendingTask = async target => {
    calls.push(target.id);
    await new Promise(resolve => { complete = resolve; });
    current.panel.removePendingTask(target.id);
    return { placed: true };
  };
  const retry = current.panel.retryPendingTasks(saved.id);
  const immediate = current.panel.loadPendingTasks().find(target => target.id === saved.id);
  assert.equal(immediate.lastRecoveryError, null);
  assert.match(immediate.recoveryMessage, /重新取回/);
  await Promise.resolve();
  assert.deepEqual(calls, [saved.id]);
  complete();
  await retry;
  assert.equal(current.panel.loadPendingTasks()[0].autoResume, false);
});

test('cached completed result can retry without a platform connection or another download', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest)));
  let calls = 0;
  current.panel.evalHost = async () => { calls += 1; return { placed: true }; };
  await current.panel.retryPendingTasks('task-original');
  assert.equal(calls, 1);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('offline cached retry failure retains the result without scheduling network recovery for other tasks', async currentTest => {
  const current = harness();
  const filePath = cachedFile(currentTest);
  current.panel.upsertPendingTask(task(filePath));
  current.panel.upsertPendingTask(task('', { id: 'network-task', stage: 'waiting', result: null, autoResume: true }));
  current.panel.evalHost = async () => { throw Object.assign(Error('Code: -1'), { phase: 'putPixels' }); };
  await current.panel.retryPendingTasks('task-original');
  assert.equal(current.timers.size, 0);
  assert.equal(current.panel.loadPendingTasks().length, 2);
  assert.equal(fs.existsSync(filePath), true);
});

test('recovery reports reach the task card while a write is running and do not resurrect a returned task', async currentTest => {
  const current = harness();
  current.panel.gatewayClient = {};
  current.panel.upsertPendingTask(task(cachedFile(currentTest)));
  current.panel.processSelectionPendingTask = async (saved, client, report) => {
    report('正在下载已有结果', 'working');
    assert.match(current.panel.loadPendingTasks()[0].recoveryMessage, /下载已有结果/);
    current.panel.removePendingTask(saved.id);
    report('结果已放回', 'success');
    assert.equal(current.panel.loadPendingTasks().length, 0);
    return { placed: true };
  };
  await current.panel.retryPendingTasks('task-original');
});

test('retry without a connection explains the reason inside the task dialog', async () => {
  const current = harness();
  const notice = { hidden: true };
  current.panel.document = {};
  current.panel.getElement = identity => identity === 'taskProgressNotice' ? notice : null;
  current.panel.upsertPendingTask(task('', { result: null, stage: 'waiting' }));
  await current.panel.retryPendingTasks('task-original');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /连接平台/);
  assert.equal(current.panel.loadPendingTasks()[0].autoResume, false);
});

test('retry during an existing recovery reports running without duplicating the write', async () => {
  const current = harness();
  const notice = { hidden: true };
  current.panel.document = {};
  current.panel.getElement = identity => identity === 'taskProgressNotice' ? notice : null;
  current.panel.gatewayClient = {};
  current.panel.upsertPendingTask(task('cache'));
  current.panel.resumingTasks['task-original'] = true;
  let calls = 0;
  current.panel.processSelectionPendingTask = async () => { calls += 1; };
  await current.panel.retryPendingTasks('task-original');
  assert.equal(calls, 0);
  assert.match(notice.textContent, /正在取回/);
});

test('return diagnostics retain compatibility and rollback failures rather than only RGBA -1', currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest));
  current.panel.markTaskForRecovery(saved, Object.assign(Error('Photoshop Error. Code: -1'), {
    phase: 'putPixels', compatibilityError: 'mask failure', compatibilityPhase: 'putLayerMask', rollbackError: 'rollback failure'
  }));
  const error = current.panel.loadPendingTasks()[0].lastRecoveryError;
  assert.equal(error.compatibilityError, 'mask failure');
  assert.equal(error.compatibilityPhase, 'putLayerMask');
  assert.equal(error.rollbackError, 'rollback failure');
  assert.match(current.panel.taskFailureMessage(error, saved), /mask failure/);
});

test('corner character cleanup is removed even for legacy tasks saved with cleanupText', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { stage: 'restored', result: null, cleanupText: true });
  const events = [];
  current.panel.upsertPendingTask(saved);
  current.panel.cutoutLayer = async (input, output, options) => {
    if (options.cleanup) events.push('cleanup');
    return { path: input, healRegions: [] };
  };
  current.panel.getBackgroundReturn = () => ({ cleanup: async () => { events.push('cleanup-write'); return { cleaned: true }; } });
  current.panel.evalHost = async () => {
    assert.deepEqual(events, []);
    events.push('placed');
    return { placed: true, cleanupToken: 'receipt' };
  };
  const result = await current.panel.processSelectionPendingTask(saved, {}, () => {});
  assert.equal(result.placed, true);
  assert.deepEqual(events, ['placed']);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('legacy cleanup flag cannot requeue or reject an already returned selection', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { cleanupText: true, autoResume: true });
  current.panel.upsertPendingTask(saved);
  let placements = 0;
  current.panel.evalHost = async () => { placements += 1; return { placed: true, cleanupToken: 'receipt' }; };
  current.panel.cutoutLayer = async () => { throw Error('optional corner failure'); };
  await current.panel.resumePendingTasks({}, true);
  assert.equal(placements, 1);
  assert.equal(current.panel.loadPendingTasks().length, 0);
  assert.ok(current.reports.some(report => /已贴回|已放回/.test(report.message) && !/清理/.test(report.message)));
});

test('no detected corner changes skip the optional Photoshop cleanup write', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { cleanupText: true });
  current.panel.upsertPendingTask(saved);
  current.panel.evalHost = async () => ({ placed: true, cleanupToken: 'receipt' });
  current.panel.cutoutLayer = async input => ({ path: input, changed: false, warning: '' });
  let cleanupWrites = 0;
  current.panel.getBackgroundReturn = () => ({ cleanup: async () => { cleanupWrites += 1; return {}; } });
  await current.panel.processSelectionPendingTask(saved, {}, () => {});
  assert.equal(current.panel.loadPendingTasks().length, 0);
  assert.equal(cleanupWrites, 0);
});

test('recovered layer removes its task without post-return cleanup', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const saved = task(raw, { type: 'layer', result: { path: raw, name: 'subject' }, cleanupText: true,
    job: { name: 'subject', kind: 'element' }, exportInfo: { documentId: 42, source: task(raw).context.source },
    slot: task(raw).context.slot, target: task(raw).context.selection });
  current.panel.upsertPendingTask(saved);
  const events = [];
  current.panel.evalHost = async () => { events.push('place'); return { placed: ['subject'], receipts: { [saved.id]: { cleanupToken: 'receipt' } } }; };
  current.panel.cutoutLayer = async input => {
    assert.equal(current.panel.loadPendingTasks().length, 0);
    events.push('cleanup');
    throw Error('optional cleanup failure');
  };
  await current.panel.processLayerPendingTask(saved, {}, () => {});
  assert.deepEqual(events, ['place']);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('failed pixel placement does not run character cleanup or delete raw results', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const saved = task(raw, { stage: 'restored', result: null, cleanupText: true });
  current.panel.upsertPendingTask(saved);
  let cleanups = 0;
  const removed = [];
  current.panel.removeFile = file => removed.push(file);
  current.panel.cutoutLayer = async input => { cleanups += 1; return { path: input }; };
  current.panel.evalHost = async () => { throw Object.assign(Error('Photoshop Error. Code: -1'), { phase: 'putPixels' }); };
  await assert.rejects(current.panel.processSelectionPendingTask(saved, {}, () => {}), /Photoshop/);
  assert.equal(cleanups, 0);
  assert.equal(removed.includes(raw), false);
  assert.equal(current.panel.loadPendingTasks()[0].result.path, raw);
});

test('Photoshop -1 at return remains recoverable and retries the same slot without generation or download', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest));
  current.panel.upsertPendingTask(saved);
  const placements = [];
  let attempts = 0;
  current.panel.evalHost = async (method, args) => {
    placements.push({ method, args });
    if (++attempts === 1) throw Object.assign(Error('Photoshop Error. Code: -1'), { number: -1, phase: 'putPixels' });
    return { placed: true };
  };
  const client = { getTask() { throw Error('must not poll cached result'); }, downloadResult() { throw Error('must not download cached result'); } };
  await current.panel.resumePendingTasks(client);
  const pending = current.panel.loadPendingTasks()[0];
  assert.equal(pending.autoResume, true);
  assert.equal(pending.lastRecoveryError.phase, 'putPixels');
  assert.equal(current.timers.size, 1);
  pending.nextRecoveryAt = 0;
  current.panel.upsertPendingTask(pending);
  await current.panel.resumePendingTasks(client, true);
  assert.equal(placements.length, 2);
  assert.equal(placements[1].args[3], 42);
  assert.equal(placements[1].args[9].reservationId, 'original-reservation');
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('closing during a recovery attempt preserves eligibility for the next panel', async currentTest => {
  const first = harness();
  first.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true }));
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let complete;
  first.panel.processSelectionPendingTask = async () => { entered(); await new Promise(resolve => { complete = resolve; }); };
  const running = first.panel.resumePendingTasks({}, true);
  await started;
  assert.equal(first.panel.loadPendingTasks()[0].autoResume, true);
  first.events.beforeunload();
  const reopened = harness(first.storage);
  let placed = false;
  reopened.panel.evalHost = async () => { placed = true; return { placed: true }; };
  await reopened.panel.resumePendingTasks({}, true);
  assert.equal(placed, true);
  complete();
  await running;
});

test('old placing tasks with a valid reserved slot can recover even when the old version persisted autoResume false', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest)));
  current.panel.evalHost = async () => ({ placed: true });
  await current.panel.resumePendingTasks({}, true);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('missing processed cache re-downloads the existing trace instead of submitting another task', async currentTest => {
  const current = harness();
  const existing = cachedFile(currentTest);
  current.panel.upsertPendingTask(task(existing + '.missing'));
  const downloads = [];
  current.panel.evalHost = async (method, args) => { assert.equal(args[0], existing); return { placed: true }; };
  await current.panel.resumePendingTasks({ downloadResult: async trace => { downloads.push(trace); return existing; } });
  assert.deepEqual(downloads, ['paid-trace-original']);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('explicit safety rejection pauses instead of hammering Photoshop and retains the PNG', currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest));
  current.panel.markTaskForRecovery(saved, Object.assign(Error('会话已变化'), { recoveryBlocked: true, phase: 'validate' }));
  current.panel.scheduleTaskRecovery({});
  assert.equal(current.panel.loadPendingTasks()[0].recoveryBlocked, true);
  assert.equal(current.timers.size, 0);
  assert.equal(fs.existsSync(saved.result.path), true);
});

test('return retry uses backoff and stops automatic attempts after repeated unknown Photoshop errors', currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest));
  for (let attempt = 0; attempt < 5; attempt += 1) current.panel.markTaskForRecovery(saved, Error('Photoshop Error. Code: -1'));
  assert.equal(saved.recoveryAttempts, 5);
  assert.equal(saved.autoResume, false);
  assert.equal(saved.recoveryExhausted, true);
});

test('duplicate automatic recovery does not place an in-flight task a second time', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true }));
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let complete;
  let calls = 0;
  current.panel.evalHost = async () => { calls += 1; entered(); await new Promise(resolve => { complete = resolve; }); return { placed: true }; };
  const first = current.panel.resumePendingTasks({}, true);
  await started;
  await current.panel.resumePendingTasks({}, true);
  assert.equal(calls, 1);
  complete();
  await first;
});

test('pending layer images also retry return without recreating the platform task', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { type: 'layer', index: 0, job: { name: '角色' },
    exportInfo: { documentId: 42, source: { width: 100, height: 80, backgroundSessionId: 'original-session' } },
    result: { path: cachedFile(currentTest), name: '角色', target: { left: 0, top: 0, width: 2, height: 2 } }, slot: { layerId: 5 } });
  current.panel.upsertPendingTask(saved);
  let attempts = 0;
  current.panel.evalHost = async () => { if (++attempts === 1) throw Error('Photoshop Error. Code: -1'); return { placed: ['角色'] }; };
  await current.panel.resumePendingTasks({});
  const pending = current.panel.loadPendingTasks()[0];
  assert.equal(pending.autoResume, true);
  pending.nextRecoveryAt = 0;
  current.panel.upsertPendingTask(pending);
  await current.panel.resumePendingTasks({}, true);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('live layer return saves the placing stage before calling Photoshop', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { type: 'layer', stage: 'prepared' });
  current.panel.upsertPendingTask(saved);
  const run = { taskIds: [saved.id], jobs: [{ name: '角色' }], results: [{ path: saved.result.path, name: '角色' }],
    placed: {}, failures: {}, warnings: [], exportInfo: { documentId: 42, source: {} }, slots: [{ layerId: 5 }] };
  current.panel.evalHost = async () => {
    assert.equal(current.panel.loadPendingTasks()[0].stage, 'placing');
    throw Error('Photoshop Error. Code: -1');
  };
  await current.panel.placeLayerRun(run);
  assert.equal(current.panel.loadPendingTasks()[0].autoResume, true);
});

test('manual continue resets the retry budget without generating another image', async currentTest => {
  const current = harness();
  current.panel.gatewayClient = {};
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { recoveryAttempts: 5, recoveryExhausted: true }));
  let placed = 0;
  current.panel.evalHost = async () => { placed += 1; return { placed: true }; };
  await current.panel.retryPendingTasks();
  assert.equal(placed, 1);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('automatic scheduler waits until the persisted backoff has elapsed', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true, nextRecoveryAt: Date.now() + 60000 }));
  let placed = 0;
  current.panel.evalHost = async () => { placed += 1; return { placed: true }; };
  current.panel.scheduleTaskRecovery({});
  assert.equal(current.timers.size, 1);
  assert.ok([...current.timers.values()][0].delay > 59000);
  await current.panel.resumePendingTasks({}, true);
  assert.equal(placed, 0);
  const saved = current.panel.loadPendingTasks()[0];
  saved.nextRecoveryAt = Date.now() - 1;
  current.panel.upsertPendingTask(saved);
  const timer = [...current.timers.entries()][0];
  current.timers.delete(timer[0]);
  await timer[1].callback();
  assert.equal(placed, 1);
});

test('model catalog failure does not block return of an already downloaded image', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true }));
  const elements = {};
  current.panel.getElement = identity => elements[identity] || (elements[identity] = { value: 'test-value', textContent: '' });
  current.panel.setConnected = () => {};
  current.panel.setBusy = () => {};
  current.panel.saveSettings = () => {};
  current.panel.setConnectionPanelOpen = () => {};
  current.panel.AIGCGateway = { ...gateway, GatewayClient: function () {
    this.fetchModels = async () => { throw Error('model catalog temporarily unavailable'); };
  } };
  let placed = 0;
  current.panel.evalHost = async () => { placed += 1; return { placed: true }; };
  await current.panel.connectPlatform();
  assert.equal(placed, 1);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('Home reload resumes tracking before a slow model catalog finishes', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true }));
  const elements = {};
  current.panel.getElement = identity => elements[identity] || (elements[identity] = { value: 'test-value', textContent: '' });
  current.panel.setConnected = () => {};
  current.panel.setBusy = () => {};
  current.panel.saveSettings = () => {};
  current.panel.setConnectionPanelOpen = () => {};
  current.panel.populateModels = () => {};
  let finishCatalog;
  current.panel.AIGCGateway = { ...gateway, GatewayClient: function () {
    this.fetchModels = () => new Promise(resolve => { finishCatalog = resolve; });
  } };
  let placed = 0;
  current.panel.evalHost = async () => { placed += 1; return { placed: true }; };
  const connecting = current.panel.connectPlatform();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(placed, 1);
  finishCatalog([]);
  await connecting;
  assert.equal(placed, 1);
});

test('Home hides the panel without releasing Photoshop persistence', () => {
  const current = harness();
  const events = [];
  current.panel.csInterface.dispatchEvent = event => events.push(event);
  current.panel.csInterface.getExtensionID = () => 'com.company.aigc.selection.refiner';
  assert.equal(typeof current.panel.keepPanelAlive, 'function');
  current.panel.keepPanelAlive();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'com.adobe.PhotoshopPersistent');
  assert.equal(events[0].scope, 'APPLICATION');
  assert.equal(events[0].extensionId, 'com.company.aigc.selection.refiner');
  current.events.beforeunload();
  assert.equal(events.length, 1);
  assert.match(mainSource, /window\.addEventListener\("load", function \(\) \{\s*keepPanelAlive\(\);/);
});

test('Home reload with a fresh browser cache restores disk tasks and connection without resubmission', async currentTest => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-home-reload-'));
  currentTest.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const createStore = require('../AIGCSelectionRefiner/js/recovery-state.js').createStore;
  const first = harness();
  first.panel.recoveryStore = createStore(directory);
  first.panel.recoveryStoreInitialized = true;
  first.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: true }));
  const elements = {};
  first.panel.getElement = identity => elements[identity] || (elements[identity] = { value: '', checked: false });
  elements.platformUrl = { value: 'https://test.invalid' };
  elements.apiKey = { value: 'test-only-key' };
  first.panel.saveSettings(true);
  first.events.beforeunload();
  const reopened = harness(new Map());
  reopened.panel.recoveryStore = createStore(directory);
  reopened.panel.recoveryStoreInitialized = true;
  assert.equal(reopened.panel.loadPendingTasks().length, 1);
  assert.equal(reopened.panel.loadSettings().platformUrl, 'https://test.invalid');
  assert.equal(reopened.panel.loadSettings().apiKey, 'test-only-key');
  reopened.panel.evalHost = async () => ({ placed: true });
  await reopened.panel.resumePendingTasks({ createImage() { throw Error('must not resubmit'); } }, true);
  assert.equal(reopened.panel.loadPendingTasks().length, 0);
  const third = harness(first.storage);
  third.panel.recoveryStore = createStore(directory);
  third.panel.recoveryStoreInitialized = true;
  assert.equal(third.panel.loadPendingTasks().length, 0, 'old localStorage cannot revive a completed task');
});

test('network polling interruption resumes the original trace after reopening', async currentTest => {
  const first = harness();
  first.panel.upsertPendingTask(task('', { stage: 'waiting', result: null, downloadedPath: '', autoResume: true }));
  await first.panel.resumePendingTasks({ getTask: async () => { throw Object.assign(Error('network interrupted'), { retryable: true }); } });
  first.events.beforeunload();
  const reopened = harness(first.storage);
  const saved = reopened.panel.loadPendingTasks()[0];
  saved.nextRecoveryAt = 0;
  reopened.panel.upsertPendingTask(saved);
  const traces = [];
  const downloaded = cachedFile(currentTest);
  reopened.panel.evalHost = async () => ({ placed: true });
  await reopened.panel.resumePendingTasks({ getTask: async trace => { traces.push(trace); return { status: 'done' }; },
    downloadResult: async () => downloaded }, true);
  assert.deepEqual(traces, ['paid-trace-original']);
  assert.equal(reopened.panel.loadPendingTasks().length, 0);
});

test('unacknowledged live layer return remains queued instead of silently stopping', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { type: 'layer', stage: 'prepared' });
  current.panel.upsertPendingTask(saved);
  const run = { taskIds: [saved.id], jobs: [{ name: '角色' }], results: [{ path: saved.result.path, name: '角色' }],
    placed: {}, failures: {}, warnings: [], exportInfo: { documentId: 42, source: {} }, slots: [{ layerId: 5 }] };
  current.panel.evalHost = async () => ({ placed: [], failures: ['角色：Photoshop Error. Code: -1'] });
  await current.panel.placeLayerRun(run);
  assert.equal(current.panel.loadPendingTasks()[0].autoResume, true);
  assert.equal(fs.existsSync(saved.result.path), true);
});

test('busy layer processing does not schedule a one-millisecond recovery loop', async currentTest => {
  const current = harness();
  current.panel.layerBusy = true;
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { type: 'layer', autoResume: true, nextRecoveryAt: 1 }));
  current.panel.scheduleTaskRecovery({});
  assert.equal(current.timers.size, 0);
});

test('reopening the panel retries an exhausted return once with the same trace and original slot', async currentTest => {
  const first = harness();
  first.panel.upsertPendingTask(task(cachedFile(currentTest), { autoResume: false, recoveryAttempts: 5,
    recoveryExhausted: true, nextRecoveryAt: Date.now() + 300000,
    lastRecoveryError: { message: 'Photoshop Error. Code: -1', phase: 'placing' } }));
  first.events.beforeunload();
  const reopened = harness(first.storage);
  reopened.panel.preparePendingRecovery();
  const placements = [];
  reopened.panel.evalHost = async (method, args) => { placements.push({ method, args }); return { placed: true }; };
  await reopened.panel.resumePendingTasks({}, true);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].args[3], 42);
  assert.equal(placements[0].args[7], 'task-original');
  assert.equal(placements[0].args[9].reservationId, 'original-reservation');
  assert.equal(reopened.panel.loadPendingTasks().length, 0);
});

test('reopening restores old interrupted polling tasks without recreating the image request', async currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task('', { stage: 'waiting', result: null, autoResume: false }));
  current.panel.preparePendingRecovery();
  const downloaded = cachedFile(currentTest);
  const traces = [];
  current.panel.evalHost = async () => ({ placed: true });
  await current.panel.resumePendingTasks({ getTask: async trace => { traces.push(trace); return { status: 'done' }; },
    downloadResult: async trace => { traces.push(trace); return downloaded; } }, true);
  assert.deepEqual(traces, ['paid-trace-original', 'paid-trace-original']);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('panel startup re-arms interrupted tasks before connecting without clearing safety blocks', currentTest => {
  const current = harness();
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { recoveryExhausted: true }));
  current.panel.upsertPendingTask(task(cachedFile(currentTest), { id: 'unsafe-original', recoveryBlocked: true }));
  current.panel.getElement = () => ({ addEventListener() {} });
  current.panel.document = { addEventListener() {} };
  for (const name of ['enableTextInputIme', 'cleanupStaleTempFiles', 'populateLayerTemplates', 'setConnected',
    'renderReferenceImages', 'bindReferencePaste']) current.panel[name] = () => {};
  current.panel.getBackgroundBridge = () => ({ start: async () => {} });
  current.panel.initializeConnection = () => {
    const saved = current.panel.loadPendingTasks();
    assert.equal(saved.find(item => item.id === 'task-original').autoResume, true);
    assert.equal(saved.find(item => item.id === 'task-original').recoveryExhausted, false);
    assert.equal(saved.find(item => item.id === 'unsafe-original').recoveryBlocked, true);
  };
  current.events.load();
});

test('unacknowledged selection return retains task and every result cache for retry', async currentTest => {
  const current = harness();
  const saved = task(cachedFile(currentTest), { autoResume: true });
  current.panel.upsertPendingTask(saved);
  const removed = [];
  current.panel.removeFile = filePath => { if (filePath) removed.push(filePath); };
  current.panel.evalHost = async () => ({ placed: false });
  await current.panel.resumePendingTasks({});
  const pending = current.panel.loadPendingTasks()[0];
  assert.ok(pending);
  assert.equal(pending.traceId, saved.traceId);
  assert.equal(pending.stage, 'placing');
  assert.equal(pending.autoResume, true);
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(pending.result.path), true);
});

test('unchanged transport and stable export kernels remain identical to the installed baseline', () => {
  const baseline = path.join(__dirname, '../../AIGCSelectionRefiner-0.5.23-package');
  const original = fs.readFileSync(path.join(baseline, 'AIGCSelectionRefiner/js/main.js'), 'utf8');
  function functionSource(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name);
    const end = source.indexOf('\nfunction ', start + 10);
    return source.slice(start, end === -1 ? undefined : end);
  }
  const returnStart = '  }).then(function (imageUrl) {';
  const currentGeneration = functionSource(mainSource, 'runGeneration');
  const originalGeneration = functionSource(original, 'runGeneration');
  assert.ok(currentGeneration.includes(returnStart));
  assert.ok(originalGeneration.includes(returnStart));
  assert.equal(currentGeneration.slice(currentGeneration.indexOf(returnStart)).replace(/    releasePendingCapacity\(capacity\);\r?\n/g, ''),
    originalGeneration.slice(originalGeneration.indexOf(returnStart)), 'generation tracking and return');
  for (const name of ['renderReturnPixels', 'fitResultToSelection',
    'evalHost', 'queueHost', 'getBackgroundReturn', 'preparePendingRecovery',
    'prepareExportedImage', 'prepareSelectionUpload']) {
    assert.equal(functionSource(mainSource, name).replace(', watermarkMargin());', ');'), functionSource(original, name), name);
  }
  for (const relative of ['uxp-helper/capture.js', 'uxp-helper/reservation.js']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'),
      fs.readFileSync(path.join(baseline, relative), 'utf8'), relative);
  }
  const host = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');
  const stableHost = fs.readFileSync(path.join(__dirname, '../../AIGCSelectionRefiner-0.5.20-package/AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');
  for (const name of ['exportCroppedInPlace', 'saveCopyPng', 'compatibleExport']) {
    const body = source => {
      const start = source.indexOf('  function ' + name + '(');
      const next = source.slice(start + 10).search(/\n  (?:function |AIGCSelectionRefiner\.|var )/);
      return source.slice(start, next < 0 ? undefined : start + 10 + next);
    };
    assert.equal(body(host), body(stableHost), name);
  }
});

test('writer only changes transparent results from RGBA writes to RGB plus mask', () => {
  const source = fs.readFileSync(path.join(__dirname, '../uxp-helper/writer.js'), 'utf8');
  assert.match(source, /stripes\.some\(function \(stripe\) \{ return stripe\.components === 4; \}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/index.html'), 'utf8'), /cleanupText|角落字符/);
});

test('live layers acknowledge each result in order without cleanup or requeuing committed layers', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const saved = task(raw);
  current.panel.upsertPendingTask(saved);
  current.panel.upsertPendingTask(task(raw, { id: 'second' }));
  const events = [];
  current.panel.evalHost = async (method, args) => {
    assert.equal(args[0].length, 1);
    const item = args[0][0];
    events.push('place:' + item.taskId);
    return { placed: [item.name], receipts: { [item.taskId]: { cleanupToken: item.taskId } } };
  };
  current.panel.getBackgroundReturn = () => ({ cleanup: async (context, result, taskId) => {
    assert.equal(current.panel.loadPendingTasks().some(item => item.id === taskId), false);
    events.push('clean:' + taskId);
    throw Error('optional cleanup failed');
  } });
  const run = { jobs: [{ name: 'first' }, { name: 'second' }], taskIds: [saved.id, 'second'],
    results: [{ path: raw, name: 'first', target: saved.context.selection }, { path: raw, name: 'second', target: saved.context.selection }],
    placed: [], failures: [], warnings: [], cleanupText: true, slots: [saved.context.slot, saved.context.slot],
    exportInfo: { documentId: 42, source: saved.context.source }, groupName: 'layers' };
  await current.panel.placeLayerRun(run);
  assert.deepEqual(events, ['place:task-original', 'place:second']);
  assert.equal(run.placed[0], true);
  assert.equal(run.placed[1], true);
  assert.equal(current.panel.loadPendingTasks().length, 0);
});

test('live layer cutout failure retains raw download until placement is acknowledged', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const cropped = cachedFile(currentTest);
  const saved = task(raw);
  const removed = [];
  current.panel.removeFile = file => removed.push(file);
  current.panel.restoreSelectionFrame = async () => cropped;
  current.panel.cutoutLayer = async () => { throw Error('cutout failed'); };
  const run = { jobs: [{ name: 'subject', kind: 'element' }], traces: ['existing-trace'],
    results: [], failures: [], warnings: [], placed: [], targets: [], slots: [saved.context.slot],
    sourceFrame: {}, exportInfo: { documentId: 42, source: saved.context.source },
    workDirectory: path.dirname(raw), cleanupText: true,
    client: { getTask: async () => ({ status: 'done' }), downloadResult: async () => raw } };
  current.panel.reportLayerProgress = () => {};
  await current.panel.processLayerJob(run, 0);
  assert.equal(run.results[0].path, cropped);
  assert.equal(removed.includes(raw), false);
  assert.equal(current.panel.loadPendingTasks()[0].downloadedPath, raw);
  current.panel.evalHost = async () => ({ placed: [], failures: ['putPixels failed'] });
  await current.panel.placeLayerRun(run);
  assert.equal(removed.includes(raw), false);
  assert.equal(removed.includes(cropped), false);
});

test('transparent selection cuts out with cleanup off and reuses processed cache on retry', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const saved = task(raw, { stage: 'restored', result: null, context: {
    ...task(raw).context, generationParameters: { Background: 'transparent' }
  } });
  const processing = [];
  current.panel.cutoutLayer = async (input, output, options) => {
    processing.push(options);
    return { path: input, healRegions: [] };
  };
  current.panel.evalHost = async () => { throw Object.assign(Error('busy'), { retryable: true }); };
  await current.panel.processSelectionPendingTask(saved, {}, () => {}).catch(() => {});
  assert.equal(processing.length, 1);
  assert.equal(processing[0].key, true);
  assert.equal(processing[0].cleanup, false);
  current.panel.evalHost = async () => ({ placed: true });
  await current.panel.processSelectionPendingTask(saved, {}, () => {});
  assert.equal(processing.length, 1);
});

test('single-task retry leaves unrelated blocked jobs untouched', async currentTest => {
  const current = harness();
  current.panel.gatewayClient = {};
  const file = cachedFile(currentTest);
  current.panel.upsertPendingTask(task(file, { recoveryBlocked: true }));
  current.panel.upsertPendingTask(task(file, { id: 'other', recoveryBlocked: true }));
  let placements = 0;
  current.panel.evalHost = async () => { placements += 1; return { placed: true }; };
  await current.panel.retryPendingTasks('task-original');
  assert.equal(placements, 1);
  assert.equal(current.panel.loadPendingTasks()[0].id, 'other');
  assert.equal(current.panel.loadPendingTasks()[0].recoveryBlocked, true);
});

test('transparent processing failure preserves its raw image and does not prevent the next task returning', async currentTest => {
  const current = harness();
  const raw = cachedFile(currentTest);
  const saved = task(raw, { stage: 'restored', result: null, autoResume: true, context: {
    ...task(raw).context, generationParameters: { Background: 'transparent' }
  } });
  current.panel.upsertPendingTask(saved);
  current.panel.upsertPendingTask(task(raw, { id: 'next-task', autoResume: true }));
  current.panel.cutoutLayer = async () => { throw Error('decoder rejected image'); };
  const placements = [];
  current.panel.evalHost = async (method, args) => {
    placements.push(args[7]);
    if (args[7] === saved.id) throw Object.assign(Error('Photoshop Error. Code: -1'), { number: -1, phase: 'putPixels' });
    return { placed: true };
  };
  await current.panel.resumePendingTasks({}, true);
  assert.deepEqual(placements.sort(), ['next-task', 'task-original']);
  const pending = current.panel.loadPendingTasks();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, saved.id);
  assert.equal(pending[0].result.path, raw);
  assert.match(pending[0].cleanupWarning, /保留平台原图/);
  assert.equal(fs.existsSync(raw), true);
  assert.equal(pending[0].autoResume, true);
});

test('local transparency processing preserves real alpha and warns about opaque checkerboard pixels', async () => {
  const current = harness();
  vm.runInContext(mainSource.slice(mainSource.indexOf('function cutoutLayer('), mainSource.indexOf('function guideLayerNames(')), current.panel);
  current.panel.AIGCLayerPlan = require('../AIGCSelectionRefiner/js/layer-plan.js');
  current.panel.loadImageElement = async () => ({ width: 10, height: 10 });
  let bytes = new Uint8ClampedArray(10 * 10 * 4);
  bytes.set([155, 120, 60, 128], 4 * 45);
  bytes.set([125, 100, 50, 255], 4 * 46);
  const original = Array.from(bytes);
  let written;
  current.panel.canvasFromImage = () => ({ width: 10, height: 10, getContext: () => ({
    getImageData: () => ({ data: bytes }), putImageData: pixels => { written = Array.from(pixels.data); }
  }) });
  current.panel.writeCanvasPng = (canvas, output) => output;
  const alphaResult = await current.panel.cutoutLayer('raw.png', 'alpha.png', { key: true, cleanup: false });
  assert.deepEqual(written, original);
  assert.equal(alphaResult.warning, '');
  bytes = new Uint8ClampedArray(10 * 10 * 4).fill(255);
  bytes.set([150, 150, 150, 255], 4 * 45);
  const opaque = Array.from(bytes);
  const opaqueResult = await current.panel.cutoutLayer('raw.png', 'opaque.png', { key: true, cleanup: false });
  assert.deepEqual(written, opaque);
  assert.match(opaqueResult.warning, /没有真实透明通道/);
});
