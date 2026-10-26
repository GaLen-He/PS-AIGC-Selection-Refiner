const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function store(currentTest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-state-'));
  currentTest.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, current: require('../AIGCSelectionRefiner/js/recovery-state.js').createStore(directory) };
}

test('migrates existing tasks and reloads without browser storage', currentTest => {
  const { directory, current } = store(currentTest);
  const tasks = [{ id: 'original', traceId: 'original-trace', type: 'selection' }];
  assert.deepEqual(current.read('tasks', tasks), tasks);
  const reopened = require('../AIGCSelectionRefiner/js/recovery-state.js').createStore(directory);
  assert.deepEqual(reopened.read('tasks', []), tasks);
});

test('finished tasks stay removed after reopening with stale browser storage', currentTest => {
  const { directory, current } = store(currentTest);
  const tasks = [{ id: 'original', traceId: 'original-trace' }];
  current.write('tasks', tasks);
  current.write('tasks', []);
  const reopened = require('../AIGCSelectionRefiner/js/recovery-state.js').createStore(directory);
  assert.deepEqual(reopened.read('tasks', tasks), []);
});

test('atomic write failure preserves the previous committed journal', currentTest => {
  const { directory, current } = store(currentTest);
  current.write('tasks', [{ id: 'saved' }]);
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Error('simulated disk interruption'); };
  try { assert.throws(() => current.write('tasks', [{ id: 'new' }]), /simulated disk interruption/); }
  finally { fs.renameSync = realRename; }
  assert.deepEqual(current.read('tasks', []), [{ id: 'saved' }]);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('invalid state names and malformed values cannot overwrite task storage', currentTest => {
  const { current } = store(currentTest);
  assert.throws(() => current.write('../outside', []));
  assert.throws(() => current.write('tasks', {}));
  assert.throws(() => current.write('settings', []));
});
