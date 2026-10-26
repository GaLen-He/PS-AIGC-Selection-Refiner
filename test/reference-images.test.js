const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const gateway = require('../cep/AIGCSelectionRefiner/js/api-client');
const frame = require('../cep/AIGCSelectionRefiner/js/selection-frame');

const mainSource = fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/js/main.js'), 'utf8');

function loadPanel() {
  const panel = vm.createContext({ require, Buffer, Uint8Array, Uint8ClampedArray, CSInterface: function () {}, window: { addEventListener() {} }, AIGCSelectionFrame: frame });
  vm.runInContext(mainSource, panel);
  panel.AIGCGateway = gateway;
  panel.getElement = id => id === 'prompt' ? { value: '保持图1，参考图2' } : { checked: false };
  panel.getSelectedModelKey = () => 'image-model';
  panel.readParameterValues = () => ({ AspectRatio: '4:3' });
  panel.saveSettings = () => {};
  panel.updateControls = () => {};
  panel.setStatus = () => {};
  panel.connected = true;
  panel.waitForTask = async () => {};
  return panel;
}

function reference(name, bytes) {
  return { name, buffer: Buffer.from(bytes || name), preview: 'data:image/png;base64,AA==', width: 100, height: 80 };
}

test('concurrent selection jobs freeze their own reference order and original PSD', async () => {
  const panel = loadPanel();
  const creations = [];
  const placements = [];
  const uploads = [];
  let exportCount = 0;
  panel.evalHost = async (method, args) => {
    if (method === 'exportSelection') {
      exportCount += 1;
      return { imagePath: 'selection-' + exportCount, documentId: exportCount, selection: { left: 2 }, selectionChannelName: 'snapshot-' + exportCount, source: { width: 800, height: 600 } };
    }
    if (method === 'placeResult') placements.push(args);
  };
  panel.gatewayClient = {
    async uploadSelection(file) {
      if (file.startsWith('selection-')) return 'https://cdn.test/' + file;
      uploads.push(file);
      return 'https://cdn.test/' + fs.readFileSync(file, 'utf8');
    },
    async createImage(options) { creations.push(gateway.buildCreateImagePayload(options)); return 'task-' + creations.length; },
    async downloadResult(traceId) { return traceId + '.png'; }
  };
  panel.referenceImages = [reference('material'), reference('light')];
  const first = panel.runGeneration();
  panel.referenceImages.splice(0, 2, reference('different'));
  const second = panel.runGeneration();
  await Promise.all([first, second]);
  const bySelection = Object.fromEntries(creations.map(payload => [payload.FileInfos[0].Url, payload]));
  assert.deepEqual(bySelection['https://cdn.test/selection-1'].FileInfos.map(file => file.Url), ['https://cdn.test/selection-1', 'https://cdn.test/material', 'https://cdn.test/light']);
  assert.deepEqual(bySelection['https://cdn.test/selection-2'].FileInfos.map(file => file.Url), ['https://cdn.test/selection-2', 'https://cdn.test/different']);
  assert.deepEqual(placements.map(args => args[3]).sort(), [1, 2]);
  assert.equal(uploads.length, 3);
  assert.ok(uploads.every(file => !fs.existsSync(file) && !fs.existsSync(path.dirname(file))));
  assert.equal(panel.selectionJobs, 0);
});

test('a failed reference upload prevents generation and cleans only its temporary copy', async () => {
  const panel = loadPanel();
  const messages = [];
  const calls = [];
  let temporaryPath;
  let created = false;
  panel.setStatus = message => messages.push(message);
  panel.referenceImages = [reference('material')];
  panel.evalHost = async (method, args) => {
    calls.push([method, args]);
    if (method === 'exportSelection') return { imagePath: 'selection', documentId: 11, selectionChannelName: 'snapshot' };
  };
  panel.gatewayClient = {
    async uploadSelection(file) {
      if (file === 'selection') return 'https://cdn.test/selection';
      temporaryPath = file;
      assert.equal(fs.readFileSync(file, 'utf8'), 'material');
      throw Error('upload rejected');
    },
    async createImage() { created = true; throw Error('should not submit'); }
  };
  await panel.runGeneration();
  assert.equal(created, false);
  assert.ok(temporaryPath && !fs.existsSync(temporaryPath) && !fs.existsSync(path.dirname(temporaryPath)));
  assert.match(messages.join('\n'), /upload rejected/);
  assert.ok(calls.some(call => call[0] === 'discardSelection' && call[1][1] === 11));
  assert.equal(panel.referenceImages[0].buffer.toString(), 'material');
});

test('platform multi-image rejection is shown without retrying as single-image', async () => {
  const panel = loadPanel();
  const messages = [];
  let submissions = 0;
  panel.setStatus = message => messages.push(message);
  panel.referenceImages = [reference('extra')];
  panel.evalHost = async method => method === 'exportSelection' ? { imagePath: 'selection', documentId: 11, selectionChannelName: 'snapshot' } : {};
  panel.gatewayClient = {
    async uploadSelection() { return 'https://cdn.test/image'; },
    async createImage() { submissions += 1; throw Error('model does not support multiple images'); }
  };
  await panel.runGeneration();
  assert.equal(submissions, 1);
  assert.match(messages.join('\n'), /多图/);
  assert.match(messages.join('\n'), /model does not support multiple images/);
});

test('generation waits for selected reference files to finish loading', async () => {
  const panel = loadPanel();
  const messages = [];
  let exported = false;
  panel.referenceLoading = true;
  panel.setStatus = message => messages.push(message);
  panel.evalHost = async () => { exported = true; };
  panel.gatewayClient = {};
  await panel.runGeneration();
  assert.equal(exported, false);
  assert.match(messages.join('\n'), /参考图/);
});

test('completed reference uploads release task buffers while generation is still pending', async () => {
  const panel = loadPanel();
  const snapshots = [];
  const upload = panel.uploadReferenceImages;
  let enterWaiting;
  let finishWaiting;
  let payload;
  const waiting = new Promise(resolve => { enterWaiting = resolve; });
  panel.uploadReferenceImages = (client, references, report) => {
    snapshots.push(references);
    return upload(client, references, report);
  };
  panel.waitForTask = () => {
    enterWaiting();
    return new Promise(resolve => { finishWaiting = resolve; });
  };
  panel.referenceImages = [reference('material')];
  panel.evalHost = async method => method === 'exportSelection' ? { imagePath: 'selection', documentId: 11, selectionChannelName: 'snapshot' } : {};
  panel.gatewayClient = {
    async uploadSelection(file) { return file === 'selection' ? 'https://cdn.test/selection' : 'https://cdn.test/reference'; },
    async createImage(options) { payload = gateway.buildCreateImagePayload(options); return 'task'; },
    async downloadResult() { return 'result.png'; }
  };
  const job = panel.runGeneration();
  await waiting;
  try {
    assert.equal(panel.selectionJobs, 1);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].length, 0, 'uploaded references must not hold image buffers throughout generation');
    assert.equal(panel.referenceImages[0].buffer.toString(), 'material', 'reusable UI references must remain intact');
    assert.deepEqual(payload.FileInfos.map(file => file.Url), ['https://cdn.test/selection', 'https://cdn.test/reference']);
  } finally {
    finishWaiting();
    await job;
  }
});

test('reference reordering and removal change displayed numbering without changing an existing snapshot', () => {
  const panel = loadPanel();
  const rendered = [];
  panel.renderReferenceImages = () => rendered.push(panel.referenceImages.map(item => item.name).join(','));
  panel.referenceImages = [reference('first'), reference('second'), reference('third')];
  const snapshot = panel.referenceImages.slice();
  panel.moveReferenceImage(1, -1);
  panel.removeReferenceImage(1);
  assert.equal(panel.referenceImages.map(item => item.name).join(','), 'second,third');
  assert.equal(snapshot.map(item => item.name).join(','), 'first,second,third');
  assert.deepEqual(rendered, ['second,first,third', 'second,third']);
});

test('unreadable reference in a multi-file selection does not reorder or drop other valid files', async () => {
  const panel = loadPanel();
  const messages = [];
  panel.setStatus = message => messages.push(message);
  panel.renderReferenceImages = () => {};
  panel.readReferenceFile = async file => {
    if (file.name === 'bad.png') throw Error('bad.png cannot decode');
    return reference(file.name);
  };
  await panel.addReferenceFiles([{ name: 'first.png' }, { name: 'bad.png' }, { name: 'last.png' }]);
  assert.equal(panel.referenceImages.map(item => item.name).join(','), 'first.png,last.png');
  assert.equal(panel.referenceLoading, false);
  assert.match(messages.join('\n'), /bad\.png/);
});

test('oversized and unsupported reference files are rejected before reading', async () => {
  const panel = loadPanel();
  panel.FileReader = function () { throw Error('must not read'); };
  await assert.rejects(panel.readReferenceFile({ name: 'large.png', type: 'image/png', size: 21 * 1024 * 1024 }), /20\s*MB/);
  await assert.rejects(panel.readReferenceFile({ name: 'active.svg', type: 'image/svg+xml', size: 10 }), /PNG|JPG|WebP/);
});
