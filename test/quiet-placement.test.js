const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createGuard } = require('../cep/AIGCSelectionRefiner/js/quiet-placement');

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-aigc-quiet-test-'));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  let session;
  const guard = createGuard({
    platform: options.platform || 'win32', helperPath: __filename, tempRoot: root,
    startupTimeoutMs: 20,
    releaseTimeoutMs: 60,
    spawn(command, args, spawnOptions) {
      assert.equal(command, __filename);
      assert.equal(args.includes('-File'), false);
      assert.equal(spawnOptions.windowsHide, true);
      session = args[args.indexOf('-SessionDirectory') + 1];
      if (options.spawnError) throw Error('helper unavailable');
      if (!options.silent) queueMicrotask(() => child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n')));
      if (!options.manualClose) {
        const poll = setInterval(() => {
          if (!fs.existsSync(session)) { clearInterval(poll); return; }
          if (fs.existsSync(path.join(session, 'release'))) {
            clearInterval(poll);
            child.emit('close', 0);
          }
        }, 1);
      }
      return child;
    }
  });
  return { guard, root, child, get session() { return session; }, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

test('quiet placement executes once and releases redraw after a successful host operation', async () => {
  const current = harness();
  let runs = 0;
  try {
    const result = await current.guard.run(async () => {
      runs += 1;
      assert.equal(fs.existsSync(path.join(current.session, 'release')), false);
      return { placed: true };
    });
    assert.deepEqual(result, { placed: true });
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.cleanup(); }
});

test('host errors still release redraw and are not retried', async () => {
  const current = harness();
  let runs = 0;
  try {
    await assert.rejects(current.guard.run(async () => { runs += 1; throw Error('placement failed'); }), /placement failed/);
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.cleanup(); }
});

test('a slow helper is cancelled before normal placement and cannot freeze the window late', async () => {
  const current = harness({ silent: true });
  try {
    const result = await current.guard.run(async () => {
      assert.equal(fs.existsSync(current.session), false);
      return 'normal placement';
    });
    assert.equal(result, 'normal placement');
    current.child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n'));
    current.child.emit('close', 0);
  } finally { current.cleanup(); }
});

test('placement does not finish until the helper restores redraw', async () => {
  const current = harness({ manualClose: true });
  let finished = false;
  try {
    const pending = current.guard.run(async () => 'placed').then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(path.join(current.session, 'release')), true);
    assert.equal(finished, false);
    current.child.emit('close', 0);
    assert.equal(await pending, 'placed');
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});

test('closing a panel cancels a helper that is still starting', async () => {
  const current = harness({ silent: true });
  let runs = 0;
  try {
    const pending = current.guard.run(async () => { runs += 1; });
    current.guard.releaseActive();
    await assert.rejects(pending, /panel is closing/);
    assert.equal(runs, 0);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});

test('a helper launch failure falls back without retrying the host operation', async () => {
  const current = harness({ spawnError: true });
  let runs = 0;
  try {
    assert.equal(await current.guard.run(async () => { runs += 1; return 'normal'; }), 'normal');
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.cleanup(); }
});

test('an unresponsive helper cannot block the job queue indefinitely', async () => {
  const current = harness({ manualClose: true });
  try {
    assert.equal(await current.guard.run(async () => 'placed'), 'placed');
    assert.equal(fs.existsSync(path.join(current.session, 'release')), true);
    current.child.emit('close', 0);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});

test('non-Windows hosts place normally without launching a helper', async () => {
  const current = harness({ platform: 'darwin' });
  try {
    assert.equal(await current.guard.run(async () => 'placed'), 'placed');
    assert.equal(current.session, undefined);
  } finally { current.cleanup(); }
});

test('a helper restoration acknowledgement releases the queue before process exit', async () => {
  const current = harness({ manualClose: true });
  try {
    const pending = current.guard.run(async () => 'placed');
    await new Promise(resolve => setTimeout(resolve, 5));
    current.child.stdout.emit('data', Buffer.from('{"restored":true}\n'));
    assert.equal(await pending, 'placed');
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});

test('a running helper error keeps cancellation present until redraw restoration is acknowledged', async () => {
  const current = harness({ silent: true, manualClose: true });
  let runs = 0;
  try {
    current.child.pid = process.pid;
    const pending = current.guard.run(async () => { runs += 1; return 'normal placement'; });
    current.child.emit('error', Error('helper IPC failed after launch'));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runs, 0);
    assert.equal(fs.existsSync(path.join(current.session, 'release')), true);
    current.child.stdout.emit('data', Buffer.from('{"restored":true}\n'));
    assert.equal(await pending, 'normal placement');
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(current.session), false);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});

test('host serialization waits for redraw restoration before starting the next command', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/js/main.js'), 'utf8');
  const current = harness({ manualClose: true });
  const operations = [];
  const context = vm.createContext({
    require, CSInterface: function () {}, window: { addEventListener() {} },
    document: { activeElement: null },
    AIGCSelectionFrame: require('../cep/AIGCSelectionRefiner/js/selection-frame'),
    AIGCGateway: require('../cep/AIGCSelectionRefiner/js/api-client')
  });
  vm.runInContext(source, context);
  context.getQuietPlacementGuard = () => current.guard;
  context.evalHostNow = async method => { operations.push(method); return method; };
  try {
    const placement = context.evalHost('placeResult', []);
    const next = context.evalHost('exportSelection', []);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(operations, ['placeResult']);
    current.child.emit('close', 0);
    assert.equal(await placement, 'placeResult');
    assert.equal(await next, 'exportSelection');
    assert.deepEqual(operations, ['placeResult', 'exportSelection']);
  } finally { current.child.emit('close', 0); current.cleanup(); }
});
