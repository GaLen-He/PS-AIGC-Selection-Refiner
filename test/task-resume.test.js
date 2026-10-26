const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const frame = require('../cep/AIGCSelectionRefiner/js/selection-frame');
const gateway = require('../cep/AIGCSelectionRefiner/js/api-client');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'cep', 'AIGCSelectionRefiner', 'js', 'main.js'), 'utf8');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function loadMain(localStorage) {
  const context = vm.createContext({
    require,
    Buffer,
    Uint8Array,
    Uint8ClampedArray,
    localStorage,
    CSInterface: function () {},
    window: { addEventListener() {} },
    AIGCSelectionFrame: frame,
    AIGCGateway: gateway
  });
  vm.runInContext(mainSource, context);
  return context;
}

test('submitted platform tasks survive a panel reload', () => {
  const storage = createStorage();
  const firstPanel = loadMain(storage);
  firstPanel.upsertPendingTask({ id: 'selection-task-1', type: 'selection', traceId: 'trace-1', stage: 'waiting' });

  const reopenedPanel = loadMain(storage);
  const tasks = JSON.parse(JSON.stringify(reopenedPanel.loadPendingTasks()));
  assert.deepEqual(tasks, [{ id: 'selection-task-1', type: 'selection', traceId: 'trace-1', stage: 'waiting' }]);
});

test('reopening the panel resumes a submitted selection task and places it in its original PSD', async () => {
  const storage = createStorage();
  const panel = loadMain(storage);
  const calls = [];
  const task = {
    id: 'selection-task-2',
    type: 'selection',
    traceId: 'trace-2',
    stage: 'waiting',
    jobNumber: 2,
    cleanupText: false,
    resultPath: 'result.png',
    context: {
      selection: { left: 10, top: 20, width: 100, height: 80 },
      selectionChannelName: 'selection-snapshot',
      documentId: 42,
      source: { width: 1600, height: 900 },
      artboard: { id: 7, name: '画板 1' },
      generationFrame: null
    }
  };
  panel.upsertPendingTask(task);
  panel.updateControls = () => {};
  panel.setStatus = () => {};
  panel.removeFile = () => {};
  panel.evalHost = async (method, args) => { calls.push([method, args]); return { warnings: [] }; };
  const client = {
    getTask: async () => ({ status: 'done' }),
    downloadResult: async () => 'downloaded.png'
  };

  await panel.resumePendingTasks(client);

  const placement = calls.find(call => call[0] === 'placeResult');
  assert.ok(placement);
  assert.equal(placement[1][3], 42);
  assert.deepEqual(JSON.parse(JSON.stringify(placement[1][6])), { id: 7, name: '画板 1' });
  assert.equal(calls.filter(call => call[0] === 'discardSelection').length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.loadPendingTasks())), []);
});

test('selection return retains corner cleanup and forwards healing regions to the original PSD', async () => {
  const panel = loadMain(createStorage());
  const operations = [];
  const region = { left: 0.01, top: 0.01, right: 0.05, bottom: 0.05 };
  const task = {
    id: 'selection-cleanup', type: 'selection', stage: 'restored', cleanupText: true,
    resultPath: 'result.png', cleanupPath: 'clean.png',
    context: { documentId: 42, selection: { left: 10, top: 20, width: 100, height: 80 }, selectionChannelName: 'snapshot' }
  };
  panel.setStatus = () => {};
  panel.removeFile = () => {};
  panel.cutoutLayer = async (input, output, options) => {
    operations.push('cleanup');
    assert.equal(options.cleanup, true);
    return { path: output, healRegions: [region] };
  };
  panel.evalHost = async (method, args) => {
    operations.push(method);
    assert.equal(args[0], 'clean.png');
    assert.equal(args[3], 42);
    assert.deepEqual(JSON.parse(JSON.stringify(args[4])), [region]);
    return { warnings: [] };
  };
  await panel.processSelectionPendingTask(task, {}, () => {});
  assert.deepEqual(operations, ['cleanup', 'placeResult']);
});

test('reopening the panel places an already prepared layer result in its original group order', async () => {
  const storage = createStorage();
  const panel = loadMain(storage);
  const calls = [];
  panel.upsertPendingTask({
    id: 'layer-task-1',
    type: 'layer',
    traceId: 'trace-layer-1',
    stage: 'prepared',
    index: 1,
    job: { name: '角色', kind: 'element' },
    groupName: 'AI 分层 12:00:00',
    layerOrder: ['背景', '角色', '前景'],
    exportInfo: { documentId: 77, source: { width: 1920, height: 1080 } },
    workDirectory: 'work',
    cleanupText: false,
    target: { left: 100, top: 50, width: 600, height: 900 },
    result: { path: 'character.png', name: '角色', healRegions: [], target: { left: 100, top: 50, width: 600, height: 900 } }
  });
  panel.updateControls = () => {};
  panel.setLayerStatus = () => {};
  panel.removeFile = () => {};
  panel.evalHost = async (method, args) => {
    calls.push([method, args]);
    return { placed: ['角色'], failures: [], warnings: [] };
  };

  await panel.resumePendingTasks({});

  const placement = calls.find(call => call[0] === 'placeLayeredResult');
  assert.ok(placement);
  assert.equal(placement[1][1], 77);
  assert.equal(placement[1][2], 'AI 分层 12:00:00');
  assert.deepEqual(JSON.parse(JSON.stringify(placement[1][4])), ['背景', '角色', '前景']);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.loadPendingTasks())), []);
});

test('a terminal layer failure is discarded without claiming it will resume again', async () => {
  const storage = createStorage();
  const panel = loadMain(storage);
  const messages = [];
  panel.upsertPendingTask({
    id: 'layer-task-failed',
    type: 'layer',
    traceId: 'trace-layer-failed',
    stage: 'waiting',
    index: 0,
    job: { name: '背景', kind: 'background' },
    workDirectory: require('node:os').tmpdir(),
    exportInfo: { documentId: 88, source: { width: 1920, height: 1080 } }
  });
  panel.updateControls = () => {};
  panel.setLayerStatus = message => { messages.push(message); };

  await panel.resumePendingTasks({
    getTask: async () => ({ status: 'failed', message: '供应商生成失败' })
  });

  assert.deepEqual(JSON.parse(JSON.stringify(panel.loadPendingTasks())), []);
  assert.equal(messages.some(message => message.includes('任务仍已保存')), false);
});

test('one malformed layer recovery does not stop other saved tasks from restoring', async () => {
  const storage = createStorage();
  const panel = loadMain(storage);
  const placed = [];
  const impossibleDirectory = path.join(require('node:os').tmpdir(), 'missing-parent-' + Date.now(), 'child');
  panel.upsertPendingTask({
    id: 'layer-task-broken-directory',
    type: 'layer',
    traceId: 'trace-layer-broken',
    stage: 'waiting',
    index: 0,
    job: { name: '背景', kind: 'background' },
    workDirectory: impossibleDirectory,
    exportInfo: { documentId: 99, source: { width: 1920, height: 1080 } }
  });
  panel.upsertPendingTask({
    id: 'layer-task-ready',
    type: 'layer',
    traceId: 'trace-layer-ready',
    stage: 'prepared',
    index: 1,
    job: { name: '角色', kind: 'element' },
    groupName: 'AI 分层恢复',
    layerOrder: ['背景', '角色'],
    exportInfo: { documentId: 99, source: { width: 1920, height: 1080 } },
    result: { path: 'ready-character.png', name: '角色', healRegions: [], target: { left: 10, top: 20, width: 300, height: 500 } }
  });
  panel.updateControls = () => {};
  panel.setLayerStatus = () => {};
  panel.removeFile = () => {};
  panel.evalHost = async (method, args) => {
    if (method === 'placeLayeredResult') placed.push(args[0][0].name);
    return { placed: ['角色'], failures: [], warnings: [] };
  };

  await panel.resumePendingTasks({});

  assert.deepEqual(placed, ['角色']);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.loadPendingTasks())).map(task => task.id), ['layer-task-broken-directory']);
});
