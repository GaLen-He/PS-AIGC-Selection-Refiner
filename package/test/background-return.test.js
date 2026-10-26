const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createReturn } = require('../AIGCSelectionRefiner/js/background-return.js');

function harness() {
  const resources = new Map();
  const requests = [];
  const rendered = [];
  let next = 0;
  const bridge = {
    waitReady: async () => {},
    sessionId: () => 'original-helper-session',
    registerAsset(value) { const identity = String(++next); resources.set(identity, value); return identity; },
    releaseAsset(identity) { resources.delete(identity); },
    async request(method, args) { requests.push([method, args]); return { placed: true }; }
  };
  const returns = createReturn({ bridge, renderPixels: async (file, target, mode) => {
    rendered.push([file, target, mode]);
    return Buffer.alloc(target.width * target.height * 4);
  }, maskSize: () => 6 });
  return { returns, resources, requests, rendered, bridge };
}

test('layer return preserves retryable and blocked errors instead of reducing them to strings', async () => {
  const current = harness();
  for (const metadata of [{ retryable: true, phase: 'putPixels' }, { recoveryBlocked: true, phase: 'validate' }]) {
    const failure = Object.assign(Error('return failed'), metadata);
    current.bridge.request = async () => { throw failure; };
    await assert.rejects(current.returns.layers([{ path: 'result.png', name: '角色', taskId: 'unique', slot: context.slot,
      target: context.selection }], context, 'group', ['角色']), error => error === failure);
    assert.equal(current.resources.size, 0);
  }
});

const context = { documentId: 11, selection: { left: -2, top: 5, width: 3, height: 2 },
  source: { width: 800, height: 600, backgroundSessionId: 'original-helper-session' }, selectionMaskPath: 'selection.mask', artboard: { id: 34, name: 'board 1' },
  slot: { layerId: 101, parentId: 34, name: 'result', reservationId: 'original-reservation', maskPrepared: true } };

test('post-return cleanup keeps the original destination and passes a complete writer identity', async () => {
  const current = harness();
  await current.returns.cleanup(context, { path: 'cleaned.png' }, 'unique-task', { cleanupToken: 'receipt' });
  const [method, request] = current.requests[0];
  assert.equal(method, 'cleanup');
  assert.equal(request.name, context.slot.name);
  assert.equal(request.documentId, context.documentId);
  assert.deepEqual(request.slot, context.slot);
  assert.deepEqual(request.target, context.selection);
  assert.equal(request.cleanupToken, 'receipt');
  assert.equal(current.resources.size, 0);
});

test('return passes the persisted slot and does not recreate the selection mask in an inactive document', async () => {
  const current = harness();
  await current.returns.selection(context, { path: 'result.png' }, 'unique-task');
  assert.deepEqual(current.requests[0][1].slot, context.slot);
  assert.equal(current.requests[0][1].mask, null);
});

test('old tasks without a prepared slot are retained before rendering or contacting Photoshop', async () => {
  const current = harness();
  await assert.rejects(current.returns.selection({ ...context, slot: null }, { path: 'old.png' }, 'old'), /预建|目标图层/);
  assert.equal(current.rendered.length, 0);
  assert.equal(current.requests.length, 0);
});

test('selection reservation transfers its saved mask before returning a persisted destination', async () => {
  const current = harness();
  current.bridge.request = async (method, args) => {
    current.requests.push([method, args]);
    return { slots: [context.slot] };
  };
  const result = await current.returns.reserve(context, ['result'], null, 'original-reservation');
  assert.deepEqual(result.slots, [context.slot]);
  assert.equal(current.requests[0][0], 'reserve');
  assert.ok(current.requests[0][1].mask);
  assert.deepEqual(current.requests[0][1].target, context.selection);
  assert.equal(current.resources.size, 0);
});

test('tasks from a previous Photoshop helper session are retained instead of written to reused document IDs', async () => {
  const current = harness();
  const old = { ...context, source: { ...context.source, backgroundSessionId: 'previous-helper-session' } };
  await assert.rejects(current.returns.selection(old, { path: 'result.png' }, 'old-session'), /会话|身份/);
  assert.equal(current.requests.length, 0);
  assert.equal(current.rendered.length, 0);
});

test('selection return uses the saved mask and original document and artboard, without Photoshop placement calls', async () => {
  const current = harness();
  await current.returns.selection(context, { path: 'result.png' }, 'unique-task');
  const job = current.requests[0][1];
  assert.equal(job.documentId, 11);
  assert.deepEqual(job.artboard, context.artboard);
  assert.deepEqual(job.target, context.selection);
  assert.equal(job.taskId, 'unique-task');
  assert.equal(job.mask, null);
  assert.equal(current.rendered[0][2], 'cover');
  assert.equal(current.resources.size, 0);
});

test('legacy selection tasks without a saved mask never borrow the current selection', async () => {
  const current = harness();
  await assert.rejects(current.returns.selection({ ...context, selectionMaskPath: null, slot: null }, { path: 'old.png' }, 'old'), /旧任务|蒙版/);
  assert.equal(current.requests.length, 0);
});

test('failed return releases transport buffers without deleting the downloaded PNG', async () => {
  const current = harness();
  current.bridge.request = async () => { throw Object.assign(Error('offline'), { backgroundUnavailable: true }); };
  await assert.rejects(current.returns.selection(context, { path: 'result.png' }, 'unique-task'), /offline/);
  assert.equal(current.resources.size, 0);
});

test('layers keep independent targets and are returned in completion order with original layer order metadata', async () => {
  const current = harness();
  const layers = [{ path: 'bg.png', name: 'background', taskId: 'bg', slot: { ...context.slot, layerId: 102 }, target: { left: 0, top: 0, width: 8, height: 6 } },
    { path: 'near.png', name: 'near', taskId: 'near', slot: context.slot, target: { left: 3, top: 4, width: 2, height: 2 }, unprocessed: true }];
  const result = await current.returns.layers(layers, { documentId: 11, source: context.source, artboard: context.artboard }, 'batch-unique', ['near', 'background']);
  assert.deepEqual(result.placed, ['background', 'near']);
  assert.deepEqual(current.requests.map(request => request[1].target), layers.map(layer => layer.target));
  assert.deepEqual(current.requests.map(request => request[1].slot), layers.map(layer => layer.slot));
  assert.ok(current.requests.every(request => request[1].documentId === 11 && request[1].mask === null));
  assert.equal(current.rendered[1][2], 'contain');
  assert.equal(current.resources.size, 0);
});

test('main routes placement to the pixel return channel and export never creates an alpha channel', () => {
  const base = path.join(__dirname, '../AIGCSelectionRefiner');
  const main = fs.readFileSync(path.join(base, 'js/main.js'), 'utf8');
  const host = fs.readFileSync(path.join(base, 'host/AIGCSelectionRefiner.jsx'), 'utf8');
  const route = main.slice(main.indexOf('function evalHost('), main.indexOf('function evalHostNow('));
  assert.match(route, /getBackgroundReturn/);
  assert.doesNotMatch(route, /getQuietPlacementGuard|guard\.run/);
  assert.match(main, /exportCapturedSelection/);
  const exportCode = host.slice(host.indexOf('AIGCSelectionRefiner.exportSelection ='), host.indexOf('AIGCSelectionRefiner.exportDocument ='));
  assert.doesNotMatch(exportCode, /channels\.add|selection\.store/);
  assert.match(exportCode, /expectedContext/);
});

test('stable 0.5.14 PNG save and large-canvas export bodies are unchanged', () => {
  const current = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');
  const stable = fs.readFileSync(path.join(__dirname, '../../AIGCSelectionRefiner-0.5.14-package/AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');
  function body(source, name) {
    const start = source.indexOf('  function ' + name + '(');
    assert.ok(start >= 0);
    const end = source.indexOf('\n  function ', start + 10);
    return source.slice(start, end);
  }
  for (const name of ['exportCroppedInPlace', 'saveCopyPng']) assert.equal(body(current, name), body(stable, name));
});

test('pixel return never adds legacy corner anchor pixels to PNG results', () => {
  const main = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8');
  assert.doesNotMatch(main, /markCorners:\s*true|markCanvasCorners\(/);
});

test('both live and restored tasks carry reserved layer identity through every placement route', () => {
  const main = fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8');
  assert.match(main, /selectionMaskPath:\s*args\[8\], slot:\s*args\[9\]/);
  assert.match(main, /context\.selectionMaskPath, context\.slot\]/);
  assert.match(main, /slot:\s*task\.slot/);
  assert.match(main, /slot:\s*run\.slots && run\.slots\[index\]/);
  assert.match(main, /artboard:\s*run\.exportInfo\.artboard/);
  assert.equal((main.match(/getBackgroundReturn\(\)\.reserve\(/g) || []).length, 0);
  assert.match(main, /evalHost\("prepareSubmission", \[options\]\)/);
});
