const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const progress = require('../AIGCSelectionRefiner/js/task-progress.js');

test('failed auto-recoverable tasks can be cleared unless a recovery is running', () => {
  const tasks = [{ id: 'failed', autoResume: true, lastRecoveryError: { message: 'putPixels -1' } }];
  assert.deepEqual(progress.removableIds(tasks, {}), ['failed']);
  assert.deepEqual(progress.removableIds(tasks, { failed: true }), []);
});

test('retrying task shows live progress instead of the previous failure', () => {
  const model = progress.snapshot([{ id: 'retry', stage: 'placing', autoResume: true, recoveryMessage: '正在重新取回', lastRecoveryError: null }], false, { retry: true });
  assert.match(model.rows[0].message, /重新取回/);
  assert.equal(model.rows[0].paused, false);
});

test('task list exposes compatibility stage and rollback errors for a native write failure', () => {
  const model = progress.snapshot([{ id: 'failed', stage: 'placing', lastRecoveryError: {
    message: 'Code: -1', phase: 'putPixels', compatibilityError: 'mask failure', compatibilityPhase: 'putLayerMask', rollbackError: 'rollback failure'
  } }]);
  assert.match(model.rows[0].error, /putLayerMask.*mask failure/);
  assert.match(model.rows[0].error, /rollback failure/);
});

test('task list launcher is above platform settings', () => {
  const html = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/index.html'), 'utf8');
  assert.ok(html.indexOf('id="taskProgressButton"') < html.indexOf('class="connectionBar"'));
  assert.match(html, /id="taskProgressNotice"/);
});

function panelHarness() {
  function element(tagName) {
    return { tagName, children: [], events: {}, textContent: '', attributes: {},
      get firstChild() { return this.children[0]; },
      appendChild(child) { this.children.push(child); },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.events[name] = callback; }
    };
  }
  const nodes = { taskProgressList: element('div'), taskProgressSummary: element('summary') };
  const storage = new Map();
  const panel = vm.createContext({ module: { exports: {} }, require, Buffer, Uint8Array, Uint8ClampedArray,
    document: { getElementById: identity => nodes[identity], createElement: element },
    CSInterface: function () {}, window: { addEventListener() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/task-progress.js'), 'utf8'), panel);
  return { panel, nodes };
}

function loadMain(current) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8'), current.panel);
  current.panel.updateControls = () => {};
  current.panel.setStatus = () => {};
  current.panel.safeError = error => String(error.message || error);
}

test('CEP Node export also registers the browser global used by the panel', () => {
  const current = panelHarness();
  assert.equal(typeof current.panel.AIGCTaskProgress, 'object');
  assert.equal(current.panel.AIGCTaskProgress, current.panel.module.exports);
});

test('progress renders safe text, five stages and retries only the clicked task without focus changes', () => {
  const current = panelHarness();
  const retries = [];
  current.panel.module.exports.render(current.panel.document, [{ id: 'blocked', stage: 'placing', recoveryBlocked: true,
    lastRecoveryError: { phase: 'putPixels', message: '<img onerror=unsafe>' } }], identity => retries.push(identity), {});
  const card = current.nodes.taskProgressList.children[0];
  assert.equal(card.children[2].children.length, 5);
  assert.equal(card.children[3].textContent, '[putPixels] <img onerror=unsafe>');
  assert.equal(card.children[3].innerHTML, undefined);
  card.children[4].events.click();
  assert.deepEqual(retries, ['blocked']);
  current.panel.module.exports.render(current.panel.document, [], () => {}, {});
  assert.equal(current.nodes.taskProgressList.children.length, 1);
  assert.equal(current.nodes.taskProgressList.children[0].textContent, '没有待取回任务');
});

test('persisting a task updates the actual progress panel through main.js', () => {
  const current = panelHarness();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8'), current.panel);
  current.panel.upsertPendingTask({ id: 'new-task', type: 'selection', stage: 'downloading', jobNumber: 4 });
  assert.match(current.nodes.taskProgressSummary.textContent, /进行中 1/);
  assert.equal(current.nodes.taskProgressList.children[0].children[1].textContent, '下载结果');
  current.panel.removePendingTask('new-task');
  assert.equal(current.nodes.taskProgressList.children[0].textContent, '没有待取回任务');
});

test('generation has no fabricated percent and blocked jobs are separate from active jobs', () => {
  const model = progress.snapshot([
    { id: 'one', type: 'selection', stage: 'waiting', jobNumber: 3 },
    { id: 'two', stage: 'placing', recoveryBlocked: true, lastRecoveryError: { message: '原文档关闭', phase: 'validate' } }
  ]);
  assert.equal(model.active, 1);
  assert.equal(model.paused, 1);
  assert.equal(model.rows[0].percent, null);
  assert.equal(model.rows[0].label, '平台生成中');
  assert.match(model.rows[1].error, /validate.*原文档关闭/);
});

test('steps identify the original document without credentials', () => {
  const row = progress.snapshot([{ id: 'one', type: 'layer', job: { name: '角色' }, stage: 'prepared',
    exportInfo: { source: { name: '原稿.psd' } }, apiKey: 'secret' }]).rows[0];
  assert.equal(row.step, 3);
  assert.match(row.title, /角色/);
  assert.equal(row.document, '原稿.psd');
  assert.equal(JSON.stringify(row).includes('secret'), false);
});

test('tasks sort by submission time rather than latest retry time', () => {
  const tasks = [{ id: 'old', createdAt: 1, updatedAt: 99 }, { id: 'new', createdAt: 2 }];
  assert.deepEqual(progress.snapshot(tasks).rows.map(row => row.id), ['new', 'old']);
  assert.deepEqual(progress.snapshot(tasks, true).rows.map(row => row.id), ['old', 'new']);
  assert.deepEqual(tasks.map(row => row.id), ['old', 'new']);
});

test('only paused non-running tasks may be removed', () => {
  const tasks = [{ id: 'active' }, { id: 'paused', autoResume: false }, { id: 'running', recoveryBlocked: true }];
  assert.deepEqual(progress.removableIds(tasks, { running: true }), ['paused']);
});

test('paused cleanup persists without deleting result files or allowing running tasks to be removed', () => {
  const current = panelHarness();
  loadMain(current);
  current.panel.window.confirm = () => true;
  current.panel.removeFile = () => { throw Error('cleanup must not delete images'); };
  current.panel.upsertPendingTask({ id: 'paused', autoResume: false, result: { path: 'keep.png' } });
  current.panel.upsertPendingTask({ id: 'running', recoveryBlocked: true });
  current.panel.upsertPendingTask({ id: 'active' });
  current.panel.resumingTasks.running = true;
  current.panel.dismissPendingTasks();
  assert.deepEqual(Array.from(current.panel.loadPendingTasks(), task => task.id), ['running', 'active']);
  current.panel.dismissPendingTasks('running');
  assert.equal(current.panel.loadPendingTasks().length, 2);
});

test('capacity reservations include concurrent submissions and never discard existing tasks', () => {
  const current = panelHarness();
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8'), current.panel);
  for (let index = 0; index < 18; index++) current.panel.upsertPendingTask({ id: 'task-' + index });
  const reservation = current.panel.reservePendingCapacity(2);
  assert.throws(() => current.panel.reservePendingCapacity(1), /20/);
  current.panel.upsertPendingTask({ id: 'submitted' });
  current.panel.releasePendingCapacity(reservation, 1);
  assert.throws(() => current.panel.reservePendingCapacity(1), /20/);
  current.panel.releasePendingCapacity(reservation);
  assert.equal(current.panel.reservePendingCapacity(1).remaining, 1);
  assert.equal(current.panel.loadPendingTasks().length, 19);
});

test('task UI is a bounded popup rather than expanding details at panel bottom', () => {
  const html = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/index.html'), 'utf8');
  assert.match(html, /id="taskProgressOverlay"[^>]*hidden/);
  assert.match(html, /aria-labelledby="taskProgressSummary"/);
  assert.match(html, /id="taskSortButton"/);
  assert.match(html, /id="clearPausedTasksButton"/);
  assert.doesNotMatch(html, /<details class="taskProgressPanel"/);
});

test('canceling removal preserves pending tasks and the last layer run', () => {
  const current = panelHarness(); loadMain(current);
  current.panel.upsertPendingTask({ id: 'paused', autoResume: false });
  current.panel.lastLayerRun = { taskIds: ['paused'] };
  current.panel.window.confirm = () => false;
  current.panel.dismissPendingTasks('paused');
  assert.equal(current.panel.loadPendingTasks().length, 1);
  assert.ok(current.panel.lastLayerRun);
});

test('single removal does not resurrect old layer runs and cannot remove active layers', () => {
  const current = panelHarness(); loadMain(current);
  current.panel.window.confirm = () => true;
  current.panel.upsertPendingTask({ id: 'first', type: 'layer', autoResume: false });
  current.panel.upsertPendingTask({ id: 'second', type: 'layer', autoResume: false });
  current.panel.lastLayerRun = { taskIds: ['first', 'second'] };
  current.panel.layerBusy = true;
  current.panel.dismissPendingTasks('first');
  assert.equal(current.panel.loadPendingTasks().length, 2);
  current.panel.layerBusy = false;
  current.panel.dismissPendingTasks('first');
  assert.deepEqual(Array.from(current.panel.loadPendingTasks(), task => task.id), ['second']);
  assert.equal(current.panel.lastLayerRun, null);
});

test('legacy queues over twenty are preserved rather than silently discarding recoverable jobs', () => {
  const current = panelHarness(); loadMain(current);
  for (let index = 0; index < 25; index++) current.panel.upsertPendingTask({ id: 'legacy-' + index });
  assert.equal(current.panel.loadPendingTasks().length, 25);
  assert.throws(() => current.panel.reservePendingCapacity(1), /20/);
  assert.equal(current.panel.loadPendingTasks().length, 25);
});

test('pre-submit settings failures release selection and layer capacity without contacting the platform', () => {
  for (const method of ['runGeneration', 'runLayeredPsd']) {
    const current = panelHarness(); loadMain(current);
    current.panel.connected = true;
    current.panel.gatewayClient = {};
    current.panel.getElement = identity => ({ value: identity === 'layerList' ? '角色' : 'refine', checked: true });
    current.panel.getSelectedModelKey = () => 'image-model';
    current.panel.getSelectedModel = () => ({});
    current.panel.readParameterValues = () => ({});
    current.panel.readLayerModelConfig = () => ({});
    current.panel.setLayerStatus = () => {};
    current.panel.AIGCLayerPlan = { parseLayerList: () => ['角色'], buildLayerJobs: () => [{ name: '角色' }] };
    current.panel.saveSettings = () => { throw Error('configuration unavailable'); };
    current.panel.exportCapturedSelection = current.panel.exportPixelSubmission = () => { throw Error('must not capture or upload'); };
    assert.doesNotThrow(() => current.panel[method]());
    assert.equal(current.panel.pendingCapacity, 0);
    assert.equal(current.panel.selectionJobs, 0);
    assert.equal(current.panel.layerBusy, false);
  }
});
