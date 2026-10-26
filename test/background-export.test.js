const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.join(__dirname, '../cep/AIGCSelectionRefiner');
const hostSource = fs.readFileSync(path.join(root, 'host/AIGCSelectionRefiner.jsx'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');

function exportHarness(options = {}) {
  const changes = [];
  const exports = [];
  const document = {
    width: 4000, height: 2000, mode: 'RGB', bitsPerChannel: 8, layerSets: [],
    flatten() { changes.push('flatten'); }, crop() { changes.push('crop'); },
    saveAs() { changes.push('saveAs'); }, convertProfile() { changes.push('convert'); },
    resizeImage() { changes.push('resize'); },
    exportDocument(file, type, settings) {
      exports.push({ file, type, settings });
      if (options.failExport) throw Error('Save for Web unavailable');
    },
    ...options.document
  };
  Object.defineProperty(document, 'activeHistoryState', {
    get() { return 'initial'; }, set() { changes.push('restore-history'); }
  });
  const context = vm.createContext({
    app: { activeDocument: document, preferences: { rulerUnits: 'inches' } },
    DocumentMode: { RGB: 'RGB' }, BitsPerChannelType: { EIGHT: 8 }, Units: { PIXELS: 'px' },
    ExportOptionsSaveForWeb: function () {}, ExportType: { SAVEFORWEB: 'web' }, SaveDocumentType: { PNG: 'png' },
    PNGSaveOptions: function () {}, Extension: { LOWERCASE: 'lower' },
    Intent: { RELATIVECOLORIMETRIC: 0 }, UnitValue: function (value) { return value; },
    ResampleMethod: { BICUBIC: 0 }
  });
  document.suspendHistory = (name, code) => vm.runInContext(code, context);
  vm.runInContext(hostSource.replace(/\}\(\)\);\s*$/, 'AIGCSelectionRefiner.testExport = exportCroppedInPlace; }());'), context);
  return { api: context.AIGCSelectionRefiner, document, changes, exports, context };
}

test('RGB/8 selection export never crops, flattens, resizes or restores history in the original PSD', () => {
  const current = exportHarness();
  const preparation = current.api.testExport(current.document, { left: 100, top: 200, width: 300, height: 400 }, 'image.png');
  assert.deepEqual(current.changes, []);
  assert.equal(current.exports.length, 1);
  assert.equal(current.exports[0].type, 'web');
  assert.equal(current.exports[0].settings.format, 'png');
  assert.equal(current.exports[0].settings.PNG8, false);
  assert.equal(current.exports[0].settings.transparency, false);
  assert.deepEqual(JSON.parse(JSON.stringify(preparation)), {
    canvas: { width: 4000, height: 2000 }, crop: { left: 100, top: 200, width: 300, height: 400 }, maxSize: 2048
  });
  assert.equal(current.context.app.preferences.rulerUnits, 'inches');
});

test('whole document background export retains source dimensions for local resizing', () => {
  const current = exportHarness();
  const preparation = current.api.testExport(current.document, null, 'image.png');
  assert.deepEqual(current.changes, []);
  assert.deepEqual(JSON.parse(JSON.stringify(preparation.crop)), { left: 0, top: 0, width: 4000, height: 2000 });
});

test('Save for Web failure falls back to compatible cropped export and restores history', () => {
  const current = exportHarness({ failExport: true });
  const result = current.api.testExport(current.document, { left: 10, top: 20, right: 110, bottom: 120 }, 'image.png');
  assert.equal(result, null);
  assert.ok(current.changes.includes('crop'));
  assert.ok(current.changes.includes('restore-history'));
  assert.equal(current.context.app.preferences.rulerUnits, 'inches');
});

test('artboard exports retain their established Photoshop coordinate path', () => {
  const current = exportHarness({ document: { layerSets: [{ typename: 'LayerSet', artboardEnabled: true }] } });
  current.api.testExport(current.document, { left: 100, top: 20, right: 300, bottom: 120, width: 200, height: 100 }, 'image.png');
  assert.equal(current.exports.length, 0);
  assert.ok(current.changes.includes('crop'));
});

test('negative-coordinate selections retain the compatible artboard-space crop path', () => {
  const current = exportHarness();
  current.api.testExport(current.document, { left: -100, top: 20, right: 100, bottom: 120, width: 200, height: 100 }, 'image.png');
  assert.equal(current.exports.length, 0);
  assert.ok(current.changes.includes('crop'));
});

test('16-bit and oversized PSDs use the compatible path rather than unsafe full-canvas export', () => {
  for (const document of [{ bitsPerChannel: 16 }, { width: 20000, height: 10000 }]) {
    const current = exportHarness({ document });
    current.api.testExport(current.document, null, 'image.png');
    assert.equal(current.exports.length, 0);
    assert.ok(current.changes.includes('saveAs'));
    assert.ok(current.changes.includes('restore-history'));
  }
});

function panelHarness(image) {
  const context = vm.createContext({ require, Buffer, CSInterface: function () {}, window: { addEventListener() {} } });
  vm.runInContext(mainSource, context);
  const draws = [];
  const removed = [];
  const canvases = [];
  context.loadImageElement = async () => image;
  context.document = { createElement() {
    const canvas = { getContext: () => ({ drawImage(...values) { draws.push(values); } }) };
    canvases.push(canvas);
    return canvas;
  } };
  context.writeCanvasPng = (canvas, output) => output;
  context.removeFile = file => removed.push(file);
  return { context, draws, removed, canvases };
}

test('local preparation crops the exact selection before limiting its longest edge', async () => {
  const current = panelHarness({ width: 6000, height: 4000 });
  const exported = {
    imagePath: 'source.png', documentId: 11,
    imagePreparation: { canvas: { width: 6000, height: 4000 }, crop: { left: 1000, top: 500, width: 3000, height: 1500 }, maxSize: 2048 }
  };
  const prepared = await current.context.prepareExportedImage(exported);
  assert.equal(prepared, exported);
  assert.equal(prepared.imagePath, 'source-prepared.png');
  assert.equal(prepared.imagePreparation, undefined);
  assert.deepEqual(current.draws[0].slice(1), [1000, 500, 3000, 1500, 0, 0, 2048, 1024]);
  assert.equal(current.canvases[0].width, 2048);
  assert.equal(current.canvases[0].height, 1024);
  assert.deepEqual(current.removed, ['source.png']);
});

test('local preparation rejects an unexpected full canvas rather than misplacing the selection', async () => {
  const current = panelHarness({ width: 500, height: 400 });
  await assert.rejects(() => current.context.prepareExportedImage({
    imagePath: 'source.png', imagePreparation: { canvas: { width: 1000, height: 800 }, crop: { left: 20, top: 30, width: 100, height: 200 }, maxSize: 2048 }
  }), /尺寸/);
  assert.equal(current.draws.length, 0);
});

test('failed local PNG write cleans both intermediate files without changing the source binding', async () => {
  const current = panelHarness({ width: 500, height: 400 });
  current.context.writeCanvasPng = () => { throw Error('disk full'); };
  const exported = { imagePath: 'source.png', documentId: 11, imagePreparation: {
    canvas: { width: 500, height: 400 }, crop: { left: 10, top: 20, width: 100, height: 100 }, maxSize: 2048
  } };
  await assert.rejects(() => current.context.prepareExportedImage(exported), /disk full/);
  assert.deepEqual(current.removed, ['source.png', 'source-prepared.png']);
  assert.equal(exported.documentId, 11);
  assert.equal(exported.imagePath, 'source.png');
});
