const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const calls = [];
  const modalCalls = [];
  let modalActive = false;
  const execution = { isCancelled: false };
  const target = { id: 42, width: 12000, height: 8000, historyStates: [{}, {}], activeHistoryState: { id: 81, name: 'reserved' } };
  const args = { documentId: 42, source: { width: 12000, height: 8000 }, historyStamp: '2:reserved',
    selection: { left: 100, top: 200, width: 6000, height: 4000 } };
  const image = { width: 2048, height: 1365, componentSize: 8, components: 3,
    getData: async () => {
      assert.equal(modalActive, true, 'Photoshop pixel extraction requires modal scope');
      calls.push('read'); return new Uint8Array(2048 * 1365 * 3).fill(127);
    }, dispose() { calls.push('dispose'); } };
  const photoshop = { app: { documents: [target], activeDocument: { id: 99 } },
    core: { async executeAsModal(callback, options) {
      modalCalls.push(options);
      modalActive = true;
      try { return await callback(execution); } finally { modalActive = false; }
    } },
    imaging: { async getPixels(options) {
      if (!modalActive) throw Error('The requested functionality is only allowed from inside a modal scope.');
      calls.push(options); return { imageData: image, level: 0,
      sourceBounds: { left: 100, top: 200, right: 6100, bottom: 4200 } }; } } };
  const createReader = require('../uxp-helper/snapshot-reader.js').createReader;
  return { calls, modalCalls, execution, target, args, image, photoshop,
    isModal: () => modalActive, read: createReader(photoshop) };
}

test('reads the original bounded region inside the required modal scope without document activation', async () => {
  const current = harness();
  const result = await current.read(current.args);
  assert.equal(current.calls[0].documentID, 42);
  assert.equal(current.calls[0].historyStateID, 81);
  assert.deepEqual(current.calls[0].sourceBounds, { left: 100, top: 200, right: 6100, bottom: 4200 });
  assert.deepEqual(current.calls[0].targetSize, { width: 2048, height: 1365 });
  assert.equal(result.data.length, 2048 * 1365 * 4);
  assert.equal(result.data[3], 255);
  assert.equal(current.photoshop.app.activeDocument.id, 99);
  assert.equal(current.calls.at(-1), 'dispose');
  assert.equal(current.modalCalls.length, 1);
  assert.equal(current.modalCalls[0].interactive, true);
  assert.equal(current.isModal(), false);
});

test('queued modal entry revalidates the source before requesting pixels', async () => {
  for (const change of ['closed', 'resized', 'edited', 'expired']) {
    const current = harness();
    current.photoshop.core.executeAsModal = async callback => {
      if (change === 'closed') current.photoshop.app.documents = [];
      if (change === 'resized') current.target.width = 100;
      if (change === 'edited') current.target.activeHistoryState = { id: 90, name: 'reserved' };
      if (change === 'expired') current.args.deadline = 1;
      return callback(current.execution);
    };
    await assert.rejects(current.read(current.args), /关闭|变化|超时/);
    assert.equal(current.calls.length, 0);
  }
});

test('modal cancellation before or during extraction stops submission and releases the image', async () => {
  const cancelled = harness();
  cancelled.execution.isCancelled = true;
  await assert.rejects(cancelled.read(cancelled.args), /取消/);
  assert.equal(cancelled.calls.length, 0);
  const current = harness();
  current.image.getData = async () => {
    current.execution.isCancelled = true;
    return new Uint8Array(2048 * 1365 * 3);
  };
  await assert.rejects(current.read(current.args), /取消/);
  assert.equal(current.calls.at(-1), 'dispose');
  assert.equal(current.isModal(), false);
});

test('RGBA conversion yields after releasing Photoshop modal scope', async () => {
  const current = harness();
  const scopes = [];
  const source = fs.readFileSync(path.join(__dirname, '../uxp-helper/snapshot-reader.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, setTimeout(callback) {
    scopes.push(current.isModal());
    callback();
  } });
  vm.runInContext(source, context);
  await context.module.exports.createReader(current.photoshop)(current.args);
  assert.ok(scopes.length > 0);
  assert.ok(scopes.every(value => value === false));
});

test('pyramid-level trimming retains original placement including negative artboard coordinates', async () => {
  const current = harness();
  current.args.selection.left = -600;
  current.photoshop.imaging.getPixels = async () => ({ imageData: current.image, level: 2,
    sourceBounds: { left: -100, top: 50, right: 1000, bottom: 900 } });
  const result = await current.read(current.args);
  assert.deepEqual(result.bounds, { left: -400, top: 200, width: 4400, height: 3400 });
});

test('switching documents during pixel read does not interrupt or redirect the captured history', async () => {
  const current = harness();
  current.image.getData = async () => { current.photoshop.app.activeDocument = { id: 101 };
    current.target.activeHistoryState = { id: 90, name: 'later edit' }; return new Uint8Array(2048 * 1365 * 3); };
  const result = await current.read(current.args);
  assert.equal(result.width, 2048);
  assert.equal(current.calls[0].historyStateID, 81);
});

test('closed, resized, edited or expired sources do not fall back to the current document or save PNG', async () => {
  const current = harness();
  await assert.rejects(current.read({ ...current.args, documentId: 999 }), /原文档/);
  await assert.rejects(current.read({ ...current.args, historyStamp: 'old' }), /变化/);
  await assert.rejects(current.read({ ...current.args, source: { width: 1, height: 1 } }), /变化/);
  await assert.rejects(current.read({ ...current.args, deadline: 1 }), /超时/);
  assert.equal(current.calls.length, 0);
});

test('malformed image buffers are rejected and disposed', async () => {
  const current = harness();
  current.image.getData = async () => new Uint8Array(1);
  await assert.rejects(current.read(current.args), /像素/);
  assert.equal(current.calls.at(-1), 'dispose');
});

test('new submission preparation does not save, export, flatten or activate a document', () => {
  const file = path.join(__dirname, '../AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('AIGCSelectionRefiner.prepareSubmission =');
  assert.ok(start > 0);
  const end = source.indexOf('\n  AIGCSelectionRefiner.', start + 20);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /exportCroppedInPlace|saveAs|savePng|flatten\(|activateDocument\(/);
  assert.match(body, /reserveNative/);
});

test('pixel snapshot becomes a crop-sized PNG outside Photoshop with white padding and exact geometry', async () => {
  const context = vm.createContext({ require, Buffer, CSInterface: function () {}, AIGCGateway: {},
    window: { addEventListener() {} }, localStorage: { getItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../AIGCSelectionRefiner/js/main.js'), 'utf8'), context);
  const calls = [];
  context.document = { createElement() { return { getContext() { return { fillRect(...args) { calls.push(['fill', ...args]); },
    createImageData(width, height) { return { data: new Uint8Array(width * height * 4) }; },
    putImageData() {}, drawImage(...args) { calls.push(['draw', ...args.slice(1)]); } }; } }; } };
  context.writeCanvasPng = (canvas, output) => { calls.push(['png', canvas.width, canvas.height]); return output; };
  context.fs = { readFileSync() { return Buffer.alloc(20 * 30 * 4); } };
  const result = await context.preparePixelSnapshot({ path: 'pixels', width: 20, height: 30,
    bounds: { left: -100, top: 200, width: 200, height: 300 } },
  { selection: { left: -200, top: 100, width: 400, height: 600 } }, 'snapshot.png');
  assert.equal(result, 'snapshot.png');
  assert.deepEqual(calls.find(item => item[0] === 'png'), ['png', 400, 600]);
  assert.deepEqual(calls.find(item => item[0] === 'draw'), ['draw', 100, 100, 200, 300]);
});
