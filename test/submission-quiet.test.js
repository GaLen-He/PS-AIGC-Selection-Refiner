const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extension = process.env.AIGC_SUBMISSION_EXTENSION || path.join(__dirname, '../outputs/AIGCSelectionRefiner-0.5.13-package/AIGCSelectionRefiner');
const source = fs.readFileSync(path.join(extension, 'js/main.js'), 'utf8');
const { createGuard } = require(path.join(extension, 'js/quiet-placement'));

function panelHarness(operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-aigc-submit-test-'));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  const operations = [];
  const guard = createGuard({
    platform: 'win32', helperPath: __filename, tempRoot: directory,
    startupTimeoutMs: 1000, releaseTimeoutMs: 1000,
    spawn() { return child; }
  });
  const context = vm.createContext({ require, CSInterface: function () {}, window: { addEventListener() {} } });
  vm.runInContext(source, context);
  context.getQuietPlacementGuard = () => guard;
  context.evalHostNow = async (method, args) => {
    operations.push({ method, args });
    return operation ? operation(method, args) : method;
  };
  return {
    context, operations, directory,
    ready() { child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n')); },
    restored() { child.stdout.emit('data', Buffer.from('{"restored":true}\n')); },
    cleanup() { child.emit('close', 0); fs.rmSync(directory, { recursive: true, force: true }); }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

for (const method of ['exportSelection', 'exportDocument', 'placeResult', 'placeLayeredResult', 'discardSelection']) {
  test(`${method} waits for screen protection and restoration, executing once`, async () => {
    const current = panelHarness();
    let completed = false;
    const args = method === 'exportDocument' ? [66] : [];
    try {
      const pending = current.context.evalHost(method, args).then(value => { completed = true; return value; });
      await settle();
      assert.equal(current.operations.length, 0, 'host must not modify the document before helper readiness');
      current.ready();
      await settle();
      assert.deepEqual(current.operations, [{ method, args }]);
      assert.equal(completed, false, 'host queue must await restoration before resolving');
      current.restored();
      assert.equal(await pending, method);
      assert.equal(current.operations.length, 1);
    } finally { current.cleanup(); }
  });
}

test('failed selection export restores protection before releasing the queue and never repeats export', async () => {
  const failure = Error('PNG export failed');
  const current = panelHarness(method => {
    if (method === 'exportSelection') throw failure;
    return method;
  });
  let rejected = false;
  try {
    const exported = current.context.evalHost('exportSelection', []).catch(error => { rejected = true; return error; });
    const next = current.context.evalHost('openDocument', []);
    await settle();
    assert.equal(current.operations.length, 0);
    current.ready();
    await settle();
    assert.equal(rejected, false);
    assert.deepEqual(current.operations.map(entry => entry.method), ['exportSelection']);
    current.restored();
    assert.equal(await exported, failure);
    assert.equal(await next, 'openDocument');
    assert.deepEqual(current.operations.map(entry => entry.method), ['exportSelection', 'openDocument']);
  } finally { current.cleanup(); }
});

test('unavailable helper keeps export behavior and target arguments without duplicate execution', async () => {
  const current = panelHarness();
  current.context.getQuietPlacementGuard = () => null;
  try {
    assert.equal(await current.context.evalHost('exportDocument', [66]), 'exportDocument');
    assert.deepEqual(current.operations, [{ method: 'exportDocument', args: [66] }]);
  } finally { current.cleanup(); }
});

test('a non-export command does not acquire the submission shield', async () => {
  const current = panelHarness();
  try {
    assert.equal(await current.context.evalHost('openDocument', []), 'openDocument');
    assert.deepEqual(fs.readdirSync(current.directory), []);
    assert.deepEqual(current.operations.map(entry => entry.method), ['openDocument']);
  } finally { current.cleanup(); }
});
