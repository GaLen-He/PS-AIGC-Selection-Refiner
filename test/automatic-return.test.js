const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const test = require('node:test');

const extension = process.env.AIGC_RETURN_EXTENSION || path.join(__dirname, '../outputs/AIGCSelectionRefiner-0.5.18-package/AIGCSelectionRefiner');
const mainSource = fs.readFileSync(path.join(extension, 'js/main.js'), 'utf8');
const { createGuard } = require(path.join(extension, 'js/quiet-placement.js'));
const settle = () => new Promise(resolve => setTimeout(resolve, 15));

test('release deadline covers the native lease with time for teardown', () => {
  const guardSource = fs.readFileSync(path.join(extension, 'js/quiet-placement.js'), 'utf8');
  const helperSource = fs.readFileSync(path.join(extension, '../helper-source/quiet-placement.cs'), 'utf8');
  const deadline = Number(/releaseTimeoutMs \|\| (\d+)/.exec(guardSource)[1]);
  const lease = Number(/LeaseTimeoutMs = (\d+)/.exec(helperSource)[1]);
  assert.ok(deadline >= lease + 1000);
});

for (const exits of [true, false]) {
  test(`failed release writes require helper exit before reuse: exits=${exits}`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-release-failure-'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}; child.pid = 999;
    let kills = 0;
    child.kill = () => { kills++; if (exits) setTimeout(() => child.emit('exit', 0), 5); return true; };
    const fakeFs = Object.assign({}, fs, { writeFileSync(file, data) { if (path.basename(file) === 'release') throw Error('write denied'); return fs.writeFileSync(file, data); } });
    const context = vm.createContext({ module: { exports: {} }, process, Promise, setTimeout, clearTimeout, setInterval, clearInterval, require(name) { return name === 'fs' ? fakeFs : require(name); } });
    vm.runInContext(fs.readFileSync(path.join(extension, 'js/quiet-placement.js'), 'utf8'), context);
    let spawns = 0;
    const guard = context.module.exports.createGuard({ platform: 'win32', helperPath: __filename, tempRoot: directory, startupTimeoutMs: 100, heartbeatIntervalMs: 10, releaseTimeoutMs: 30, terminationTimeoutMs: 30,
      spawn() { spawns++; setImmediate(() => child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n'))); return child; }
    });
    try {
      if (exits) assert.equal(await guard.run(async () => 'placed'), 'placed');
      else {
        await assert.rejects(guard.run(async () => 'placed'), /保护|helper/i);
        await assert.rejects(guard.run(async () => { throw Error('must not run'); }), /保护|helper/i);
        assert.equal(spawns, 1);
      }
      assert.equal(kills, 1);
      child.emit('close', 0);
      assert.deepEqual(fs.readdirSync(directory), []);
    } finally { child.emit('close', 0); guard.releaseActive(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

test('a late exit from an already-restored helper cannot unblock another live helper', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-late-exit-'));
  const children = [];
  const guard = createGuard({ platform: 'win32', helperPath: __filename, tempRoot: directory, startupTimeoutMs: 100, releaseTimeoutMs: 30, terminationTimeoutMs: 30,
    spawn() {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 999; child.unref = () => {}; child.kill = () => true;
      children.push(child); setImmediate(() => child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n'))); return child;
    }
  });
  try {
    const first = guard.run(async () => 'first');
    await settle(); children[0].stdout.emit('data', Buffer.from('{"restored":true}\n')); await first;
    await assert.rejects(guard.run(async () => 'second'), /保护|helper/i);
    children[0].emit('close', 0);
    let thirdRan = false;
    await assert.rejects(guard.run(async () => { thirdRan = true; }), /保护|helper/i);
    assert.equal(thirdRan, false);
    assert.equal(children.length, 2);
  } finally { for (const child of children) child.emit('close', 0); guard.releaseActive(); fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const [method, args] of [
  ['placeResult', ['/result.png', {}, 'selection', 101]],
  ['placeLayeredResult', [[{ path: '/result.png' }], 101]],
  ['discardSelection', ['selection', 101]]
]) {
  test(`${method} runs automatically for an inactive original PSD without activation polling`, async () => {
    const commands = [];
    const context = vm.createContext({ require, setTimeout() {}, clearTimeout() {}, CSInterface: function () {}, window: { addEventListener() {} } });
    vm.runInContext(mainSource, context);
    let release;
    context.setStatus = () => {};
    context.getQuietPlacementGuard = () => ({ run: operation => operation().then(result => new Promise(resolve => { release = () => resolve(result); })) });
    context.evalHostNow = async (called, values) => {
      commands.push({ method: called, args: values });
      return called === 'documentState' ? { active: false, exists: true } : { placed: true };
    };
    const placing = context.evalHost(method, args);
    const exporting = context.evalHost('exportSelection', []);
    await settle();
    assert.deepEqual(commands, [{ method, args }]);
    release();
    await placing;
    await exporting;
    assert.deepEqual(commands.map(command => command.method), [method, 'exportSelection']);
  });
}

test('submission PNG export remains exactly the user-confirmed 0.5.14 implementation', () => {
  const host = fs.readFileSync(path.join(extension, 'host/AIGCSelectionRefiner.jsx'), 'utf8');
  const original = fs.readFileSync(path.join(__dirname, '../outputs/AIGCSelectionRefiner-0.5.14-package/AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');
  const saveFunction = source => source.slice(source.indexOf('  function saveCopyPng('), source.indexOf('\n  function ', source.indexOf('  function saveCopyPng(') + 5));
  assert.equal(saveFunction(host), saveFunction(original));
  assert.doesNotMatch(mainSource, /waitForTargetDocument|documentWaitTimer/);
});

test('placement protection renews its lease until restoration and removes the lease file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-return-lease-'));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 999;
  let session;
  let complete;
  const guard = createGuard({ platform: 'win32', helperPath: __filename, tempRoot: directory, heartbeatIntervalMs: 10, startupTimeoutMs: 200, releaseTimeoutMs: 200,
    spawn(helper, args) {
      session = args[3];
      setImmediate(() => child.stdout.emit('data', Buffer.from('{"ready":true,"frozen":true}\n')));
      return child;
    }
  });
  const pending = guard.run(() => new Promise(resolve => { complete = resolve; }));
  try {
    await settle();
    const lease = path.join(session, 'heartbeat');
    assert.ok(fs.existsSync(lease), 'long-running placements need a live lease');
    const first = fs.readFileSync(lease, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.notEqual(fs.readFileSync(lease, 'utf8'), first);
    complete({ placed: true });
    await settle();
    assert.equal(fs.existsSync(path.join(session, 'release')), true);
    child.stdout.emit('data', Buffer.from('{"restored":true}\n'));
    assert.deepEqual(await pending, { placed: true });
    assert.equal(fs.existsSync(session), false);
  } finally {
    guard.releaseActive();
    if (complete) complete({ placed: true });
    child.emit('close', 0);
    await pending;
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
