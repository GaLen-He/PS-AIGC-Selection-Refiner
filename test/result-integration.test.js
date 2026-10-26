const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const plan = require('../cep/AIGCSelectionRefiner/js/layer-plan');
const frame = require('../cep/AIGCSelectionRefiner/js/selection-frame');
const gateway = require('../cep/AIGCSelectionRefiner/js/api-client');
const root = path.join(__dirname, '..', 'cep', 'AIGCSelectionRefiner');
const mainSource = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const hostSource = fs.readFileSync(path.join(root, 'host', 'AIGCSelectionRefiner.jsx'), 'utf8');

function loadMain() {
  const context = vm.createContext({ require, Buffer, Uint8Array, Uint8ClampedArray, CSInterface: function () {}, window: { addEventListener() {} }, AIGCSelectionFrame: frame, AIGCGateway: gateway });
  vm.runInContext(mainSource, context);
  return context;
}

test('each layer crops only its own guide and retains a source-space target', async () => {
  const panel = loadMain();
  const masks = { character: { width: 10, height: 10, alpha: new Uint8Array(100) }, roof: { width: 10, height: 10, alpha: new Uint8Array(100) } };
  masks.character.alpha[65] = 255;
  masks.roof.alpha[12] = 255;
  const seen = [];
  const draws = [];
  panel.loadImageElement = async () => ({ width: 200, height: 160 });
  panel.document = { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args); }, getImageData: () => ({ data: [] }), putImageData() {} }) }) };
  panel.maskAlphaAt = mask => { seen.push(mask); return mask.alpha || []; };
  panel.AIGCLayerPlan = { ...plan, annotateGuide() {} };
  panel.findModelParameter = () => ({ options: ['1:1'] });
  panel.writeCanvasPng = (canvas, file) => file;
  const run = { jobs: [{ name: 'character' }, { name: 'roof' }, { name: 'background', kind: 'background' }], masks, targets: [], guidedUrls: [], imageUrl: 'original', exportInfo: { imagePath: 'input.png', source: { width: 1000, height: 800 } }, workDirectory: 'work', client: { uploadSelection: async file => file } };
  await panel.layerReference(run, 0);
  await panel.layerReference(run, 1);
  assert.equal(await panel.layerReference(run, 2), 'original');
  assert.ok(seen.includes(masks.character));
  assert.ok(seen.includes(masks.roof));
  assert.deepEqual(JSON.parse(JSON.stringify(run.targets[0])), plan.guideGeometry(masks.character.alpha, 10, 10, 1000, 800, ['1:1']));
  assert.notEqual(run.targets[0].left, run.targets[1].left);
  assert.ok(run.targets[0].width < 1000);
  assert.equal(draws.length, 4);
  assert.equal(draws[1][0], masks.character);
  assert.equal(draws[3][0], masks.roof);
  await panel.layerReference(run, 0);
  assert.equal(draws.length, 4, 'retry must reuse the frozen reference and transform');
});

test('result cleanup detects at native resolution and does not clip to a guide', async () => {
  const panel = loadMain();
  const operations = [];
  const region = { left: 0.02, top: 0.02, right: 0.08, bottom: 0.06 };
  panel.loadImageElement = async () => ({ width: 800, height: 400 });
  panel.canvasFromImage = (image, width, height) => {
    operations.push(['canvas', width, height]);
    return { width, height, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} }) };
  };
  panel.document = { createElement: () => ({ getContext: () => ({ drawImage(...args) { operations.push(['fit', ...args.slice(1)]); } }) }) };
  panel.AIGCResultCleanup = {
    detectCornerText(data, width, height) { operations.push(['detect', width, height]); return [{}]; },
    prepareCleanup(data, width, height, regions, options) {
      assert.equal(options.repair, true, 'confirmed text should be repaired before any host fill command');
      return { deleted: 0, healRegions: [region] };
    }
  };
  panel.AIGCLayerPlan = { ...plan, markCanvasCorners() {}, opaqueRatio: () => 0.5, chromaKey() { operations.push(['key']); return { keyed: true }; } };
  panel.writeCanvasPng = (canvas, file) => file;
  const result = await panel.cutoutLayer('input.png', 'output.png', { width: 1600, height: 800, key: true, cleanup: true, mask: {} });
  assert.deepEqual(operations.slice(0, 3), [['canvas', 800, 400], ['detect', 800, 400], ['key']]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.healRegions)), [region]);
  assert.ok(operations.some(operation => operation[0] === 'fit'));
  assert.equal(result.path, 'output.png');
});

test('cleanup with no safe detection reports that it did not remove text', async () => {
  const panel = loadMain();
  panel.loadImageElement = async () => ({ width: 800, height: 400 });
  panel.canvasFromImage = (image, width, height) => ({ width, height, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {} }) });
  panel.AIGCResultCleanup = { detectCornerText: () => [] };
  panel.writeCanvasPng = (canvas, file) => file;
  const result = await panel.cutoutLayer('input.png', 'output.png', { cleanup: true });
  assert.match(result.warning, /未识别到可安全清理的角落字符/);
});

test('cleanup is configurable and carried separately by selection and layering jobs', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /id="cleanupText"[^>]*type="checkbox"/);
  assert.ok(html.indexOf('src="js/result-cleanup.js"') < html.indexOf('src="js/main.js"'));
  assert.match(mainSource, /cleanupText: getElement\("cleanupText"\)\.checked/);
  assert.match(mainSource, /context\.documentId, result\.healRegions/);
  assert.match(mainSource, /healRegions: result\.healRegions/);
  assert.doesNotMatch(mainSource, /AIGCLayerPlan\.(applyMaskAlpha|fillOutsideMask)/);
});

function healingHarness(failFill, emptyRegion) {
  const events = [];
  const originalChannels = ['RGB'];
  const layer = { kind: 'SMARTOBJECT', transparentPixelsLocked: false, rasterize() { events.push('rasterize'); this.kind = 'NORMAL'; } };
  const document = {
    activeLayer: layer, activeChannels: originalChannels, componentChannels: ['components'],
    selection: {
      intersected: false,
      get bounds() { if (emptyRegion && this.intersected) throw Error('empty selection'); return [1, 2, 30, 40]; },
      store() { events.push('store'); }, load() { this.intersected = false; events.push('restore'); },
      select(points, operation) {
        this.intersected = true;
        events.push(JSON.parse(JSON.stringify(points)));
        events.push({ operation });
      }, deselect() { events.push('deselect'); }
    },
    channels: { add() { return { remove() { events.push('remove-channel'); } }; } }
  };
  const context = vm.createContext({
    app: { activeDocument: document }, LayerKind: { NORMAL: 'NORMAL' }, RasterizeType: { ENTIRELAYER: 'entire' },
    charIDToTypeID: value => value, stringIDToTypeID: value => value, DialogModes: { NO: 0 },
    SelectionType: { INTERSECT: 'intersect' },
    ActionReference: function () {
      this.putProperty = (type, value) => { this.property = value; };
      this.putEnumerated = (type, enumType, value) => { this.value = value; };
    },
    ActionDescriptor: function () {
      this.values = {};
      this.putEnumerated = (key, type, value) => { this.values[key] = value; };
      this.putUnitDouble = (key, type, value) => { this.values[key] = value; };
      this.putBoolean = (key, value) => { this.values[key] = value; };
      this.putReference = (key, value) => { this.values[key] = value; };
    },
    executeAction(name, descriptor) {
      events.push(name);
      if (name === 'setd') {
        assert.equal(descriptor.values.null.property, 'fsel');
        assert.equal(descriptor.values['T   '].value, 'Trsp');
      }
      if (name === 'Fl  ') {
        events.push({ fill: descriptor.values, locked: layer.transparentPixelsLocked });
        if (failFill || layer.transparentPixelsLocked || 'sampleAllLayers' in descriptor.values) throw Error('fill parameters invalid');
      }
    }
  });
  vm.runInContext(hostSource.replace(/\}\(\)\);\s*$/, 'AIGCSelectionRefiner.testHeal = healResultRegions; }());'), context);
  return { api: context.AIGCSelectionRefiner, document, layer, events, originalChannels };
}

test('host maps normalized cleanup rectangles to the fitted layer and restores selection/channels', () => {
  const harness = healingHarness(false);
  const warnings = harness.api.testHeal(harness.layer, [{ left: 0.1, top: 0.2, right: 0.2, bottom: 0.3 }], { left: 100, top: 200, width: 1000, height: 500 });
  assert.equal(warnings.length, 0);
  assert.deepEqual(harness.events.find(Array.isArray), [[200, 300], [300, 300], [300, 350], [200, 350]]);
  assert.ok(harness.events.includes('Fl  '));
  assert.ok(harness.events.includes('restore'));
  assert.ok(harness.events.includes('remove-channel'));
  assert.equal(harness.document.activeChannels, harness.originalChannels);
  assert.equal(harness.layer.transparentPixelsLocked, false);
  assert.equal(harness.events.find(event => event && event.operation).operation, 'intersect');
});

test('host cleanup failures are nonfatal and leave no selection channel', () => {
  const harness = healingHarness(true);
  const warnings = harness.api.testHeal(harness.layer, [{ left: 0, top: 0, right: 0.1, bottom: 0.1 }], { left: 0, top: 0, width: 1000, height: 500 });
  assert.equal(warnings.length, 1);
  assert.ok(harness.events.includes('restore'));
  assert.ok(harness.events.includes('remove-channel'));
  assert.equal(harness.layer.transparentPixelsLocked, false);
});

test('PS 2024 cleanup uses the shipped fill descriptor on an unlocked generated layer', () => {
  const harness = healingHarness(false);
  harness.layer.transparentPixelsLocked = true;
  const warnings = harness.api.testHeal(harness.layer, [{ left: 0, top: 0, right: 0.1, bottom: 0.1 }], { left: 0, top: 0, width: 1000, height: 500 });
  assert.equal(warnings.length, 0);
  const fill = harness.events.find(event => event && Object.prototype.hasOwnProperty.call(event, 'fill'));
  assert.deepEqual(fill.fill, { Usng: 'contentAware', Opct: 100, 'Md  ': 'Nrml' });
  assert.equal(fill.locked, false);
  assert.equal(harness.layer.transparentPixelsLocked, true);
});

test('fully transparent cleanup regions skip filling and restore the original selection', () => {
  const harness = healingHarness(false, true);
  const warnings = harness.api.testHeal(harness.layer, [{ left: 0, top: 0, right: 0.1, bottom: 0.1 }], { left: 0, top: 0, width: 1000, height: 500 });
  assert.equal(warnings.length, 0);
  assert.ok(!harness.events.includes('Fl  '));
  assert.ok(harness.events.includes('restore'));
  assert.ok(harness.events.includes('remove-channel'));
});

test('host only heals generated layers after placement geometry is fixed', () => {
  assert.match(hostSource, /resizeAndMoveLayer\(layer, fitted\);\s*var warnings = healResultRegions\(layer, job\.healRegions, fitted\)/);
  assert.match(hostSource, /resizeAndMoveLayer\(layer, target\);\s*var warnings = healResultRegions\(layer, info\.healRegions, target\)/);
  assert.match(hostSource, /warnings: job\.warnings/);
});

test('painted target replaces name-based prompts and requests the cropped aspect', async () => {
  const panel = loadMain();
  const requests = [];
  panel.AIGCLayerPlan = plan;
  panel.findModelParameter = (model, name) => name === 'AspectRatio' ? { options: ['1:1', '2:1'] } : null;
  panel.layerReference = async () => 'painted-crop';
  panel.waitForTask = async () => {};
  panel.reportLayerProgress = () => {};
  panel.removeFile = () => {};
  const target = { left: 400, top: 350, width: 200, height: 200 };
  panel.cutoutLayer = async (input, output, options) => {
    assert.equal(options.width, target.width);
    assert.equal(options.height, target.height);
    return { path: output, healRegions: [] };
  };
  const run = {
    jobs: [{ name: '近景', kind: 'element', prompt: 'name-only prompt must not be used' }],
    masks: { '近景': {} }, targets: [target], parameters: {}, results: [], failures: {}, traces: [], warnings: [],
    userPrompt: '保持画风', exportInfo: { source: { width: 1600, height: 800 } }, workDirectory: 'work',
    client: { createImage: async request => { requests.push(request); return 'task'; }, downloadResult: async () => 'raw.png' }
  };
  await panel.processLayerJob(run, 0);
  assert.equal(requests[0].prompt, plan.guidedPrompt('近景', false, '保持画风'));
  assert.equal(requests[0].parameters.AspectRatio, '1:1');
  assert.equal(requests[0].imageUrl, 'painted-crop');
  assert.deepEqual(run.results[0].target, target);
});

test('whole-image background keeps the original PSD ratio by padding and cropping', async () => {
  const panel = loadMain();
  const writes = [];
  const requests = [];
  const run = { model: {}, exportInfo: { imagePath: 'source.png', source: { width: 1600, height: 900 } }, workDirectory: 'work' };
  panel.findModelParameter = (model, name) => name === 'AspectRatio' ? { options: ['16:9', '21:9'] } : null;
  panel.writeFramedImage = async (input, output, value) => { writes.push([input, output, value]); return output; };
  assert.equal(await panel.prepareLayerSource(run), 'source.png');
  assert.equal(run.sourceRatio, '16:9');
  assert.equal(run.sourceFrame, null);
  run.exportInfo.source = { width: 1000, height: 900 };
  assert.equal(await panel.prepareLayerSource(run), require('node:path').join('work', 'source-frame.png'));
  assert.equal(run.sourceRatio, '16:9');
  assert.equal(Math.round(run.sourceFrame.contentWidth), 1000);
  assert.equal(Math.round(run.sourceFrame.contentHeight), 900);
  panel.waitForTask = async () => {};
  panel.reportLayerProgress = () => {};
  panel.removeFile = () => {};
  panel.layerReference = async () => 'padded-source';
  panel.restoreSelectionFrame = async (input, output, value) => { writes.push(['crop', value]); return output; };
  panel.cutoutLayer = async (input, output, options) => { requests.push(['cutout', input, options.width, options.height]); return { path: output, healRegions: [] }; };
  run.jobs = [{ name: '背景', kind: 'background', prompt: 'background' }]; run.masks = {}; run.targets = []; run.parameters = { AspectRatio: '21:9' };
  run.results = []; run.failures = {}; run.traces = []; run.warnings = [];
  run.client = { createImage: async request => { requests.push(request); return 'task'; }, downloadResult: async () => 'raw.png' };
  await panel.processLayerJob(run, 0);
  assert.equal(requests[0].parameters.AspectRatio, '16:9');
  assert.match(requests[0].prompt, /灰色补边/);
  assert.equal(writes[writes.length - 1][0], 'crop');
  assert.deepEqual(requests[1].slice(2), [1000, 900]);
});

test('layer recovery carries original PSD and crop transform; failed placement keeps downloads', async () => {
  const panel = loadMain();
  const requests = [];
  panel.setLayerStatus = () => {};
  panel.safeError = error => error.message;
  panel.removeFile = () => { throw Error('must not delete an unplaced file'); };
  panel.evalHost = async (...args) => { requests.push(args); throw Error('source closed'); };
  const target = { left: 240, top: 360, width: 200, height: 140 };
  const run = { jobs: [{ name: 'ground' }], results: [{ name: 'ground', path: 'saved.png', target, healRegions: [] }], placed: [], failures: {}, exportInfo: { documentId: 11, source: { width: 1000, height: 800 } }, groupName: 'batch' };
  await panel.placeLayerRun(run);
  assert.equal(requests[0][1][1], 11);
  assert.deepEqual(requests[0][1][0][0].target, target);
  assert.deepEqual(requests[0][1][3], run.exportInfo.source);
  assert.equal(run.results[0].path, 'saved.png');
});

test('a partial layer retry sends the full bottom-to-top order including missing jobs', async () => {
  const panel = loadMain();
  const requests = [];
  panel.setLayerStatus = () => {};
  panel.removeFile = () => {};
  panel.evalHost = async (...args) => { requests.push(args); return { placed: ['middle'] }; };
  const run = {
    jobs: [{ name: 'background' }, { name: 'middle' }, { name: 'foreground' }],
    results: [null, { name: 'middle', path: 'middle.png', healRegions: [] }, null],
    placed: [true, false, true], failures: {},
    exportInfo: { documentId: 11, source: { width: 1000, height: 800 } }, groupName: 'batch'
  };
  await panel.placeLayerRun(run);
  assert.deepEqual(Array.from(requests[0][1][4] || []), ['background', 'middle', 'foreground']);
  assert.equal(run.placed[1], true);
});

test('each finished layer is placed immediately instead of waiting for the whole batch', async () => {
  const panel = loadMain();
  const events = [];
  const gates = [];
  panel.setLayerStatus = () => {};
  panel.updateControls = () => {};
  panel.reportLayerProgress = () => {};
  panel.removeFile = () => {};
  panel.removeDirectory = () => {};
  panel.AIGCLayerPlan = plan;
  panel.processLayerJob = (run, index) => new Promise(resolve => { gates[index] = () => { run.results[index] = { name: run.jobs[index].name, path: index + '.png', healRegions: [] }; resolve(); }; });
  panel.evalHost = async (name, args) => { const names = args[0].map(item => item.name); events.push(names.join(',')); return { placed: names }; };
  const run = { jobs: [{ name: 'background' }, { name: 'middle' }], results: [], placed: [], traces: [], failures: {}, warnings: [], exportInfo: { documentId: 1, imagePath: 'x.png', source: { width: 10, height: 10 } }, groupName: 'batch', workDirectory: 'w' };
  const done = panel.executeLayerRun(run);
  await new Promise(resolve => setImmediate(resolve));
  gates[1]();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['middle'], 'the first finished layer must be placed before the rest finish');
  gates[0]();
  await done;
  assert.deepEqual(events, ['middle', 'background']);
  assert.deepEqual(Array.from(run.placed), [true, true]);
});

test('a downloaded layer still imports when local PNG processing fails', async () => {
  const panel = loadMain();
  const deleted = [];
  panel.waitForTask = async () => {};
  panel.reportLayerProgress = () => {};
  panel.cutoutLayer = async () => { throw Error('PNG encode failed'); };
  panel.removeFile = file => deleted.push(file);
  panel.safeError = error => error.message;
  const run = {
    jobs: [{ name: 'roof', kind: 'element' }], results: [], failures: {}, traces: ['existing-task'], warnings: [],
    exportInfo: { source: { width: 1600, height: 900 } }, workDirectory: 'work', cleanupText: true,
    client: { downloadResult: async () => 'downloaded.png' }
  };
  await panel.processLayerJob(run, 0);
  assert.equal(run.results[0].path, 'downloaded.png');
  assert.equal(run.results[0].healRegions.length, 0);
  assert.equal(run.warnings.length, 1);
  assert.deepEqual(Object.keys(run.failures), []);
  assert.ok(!deleted.includes('downloaded.png'));
});

test('selection return is bound to its PSD and preserves the downloaded image when placement fails', async () => {
  const panel = loadMain();
  const calls = [];
  const deleted = [];
  const messages = [];
  panel.connected = true;
  panel.getElement = id => id === 'prompt' ? { value: 'enhance' } : { checked: true };
  panel.getSelectedModelKey = () => 'image-model';
  panel.readParameterValues = () => ({});
  panel.saveSettings = () => {};
  panel.updateControls = () => {};
  panel.setStatus = message => messages.push(message);
  panel.safeError = error => error.message;
  panel.waitForTask = async () => {};
  panel.removeFile = file => deleted.push(file);
  panel.cutoutLayer = async () => ({ path: 'cleaned.png', healRegions: [] });
  const source = { width: 1600, height: 900 };
  panel.evalHost = async (method, args) => {
    calls.push([method, args]);
    if (method === 'exportSelection') return { imagePath: 'selection.png', selection: {}, documentId: 11, source, selectionChannelName: 'snapshot' };
    if (method === 'placeResult') throw Error('source PSD closed');
  };
  panel.gatewayClient = { uploadSelection: async () => 'reference', createImage: async () => 'task', downloadResult: async () => 'raw.png' };
  await panel.runGeneration();
  const placement = calls.find(call => call[0] === 'placeResult');
  assert.ok(placement, 'generation promise must include the return step');
  assert.equal(placement[1][3], 11);
  assert.equal(placement[1][5], source);
  assert.ok(!deleted.includes('cleaned.png'));
  assert.ok(deleted.includes('raw.png'));
  assert.match(messages[messages.length - 1], /已保留.*cleaned\.png/s);
  assert.ok(!calls.some(call => call[0] === 'discardSelection' && call[1][1] === 11));
  assert.equal(panel.loadPendingTasks().length, 1);
  assert.equal(panel.loadPendingTasks()[0].stage, 'placing');
  assert.equal(panel.selectionJobs, 0);
});
