const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');

function harness() {
  const channels = [];
  const document = {
    id: 11, width: 1000, height: 800, name: 'source.psd', activeChannels: ['RGB'], componentChannels: ['RGB'], activeLayer: {},
    layerSets: [], layers: [],
    selection: {
      shape: 'lasso-A',
      get bounds() { if (!this.shape) throw Error('no selection'); return [0, 0, 100, 100]; },
      store(channel) { channel.shape = this.shape; },
      load(channel) { this.shape = channel.shape; },
      select() { this.shape = 'rectangle'; },
      deselect() { this.shape = null; }
    },
    channels: {
      add() {
        const channel = { name: '', remove() { const index = channels.indexOf(this); if (index >= 0) channels.splice(index, 1); } };
        channels.push(channel);
        return channel;
      },
      getByName(name) { const found = channels.find(channel => channel.name === name); if (!found) throw Error('channel missing'); return found; }
    }
  };
  const other = { id: 22, channels: { getByName() { throw Error('wrong document'); } } };
  const masks = [];
  const controls = { failExport: false, failPlace: false, placedSize: [100, 100], transforms: [], rasterized: 0, moves: [] };
  const context = vm.createContext({
    app: { documents: [document, other], activeDocument: document, displayDialogs: 1, preferences: { rulerUnits: 'inches' } },
    DialogModes: { NO: 0 }, Units: { PIXELS: 'px' }, AnchorPosition: { MIDDLECENTER: 'center' }, RasterizeType: { ENTIRELAYER: 'all' }, ElementPlacement: { INSIDE: 'inside' }, Folder: { temp: { fsName: '/temp' } },
    File: function (name) { this.fsName = name; this.exists = true; this.remove = () => {}; },
    charIDToTypeID: value => value, stringIDToTypeID: value => value,
    ActionReference: function () { this.putProperty = () => {}; this.putEnumerated = () => {}; this.putIdentifier = (type, value) => { this.documentId = value; }; },
    ActionDescriptor: function () { this.putReference = (key, value) => { this.reference = value; }; },
    executeActionGet() { return { getInteger() { return context.app.activeDocument === document ? 11 : 22; } }; },
    executeAction(action, descriptor) {
      const target = descriptor.reference.documentId === 11 ? document : descriptor.reference.documentId === 22 ? other : null;
      if (!target || !context.app.documents.includes(target)) throw Error('document closed');
      context.app.activeDocument = target;
    },
    __test: {
      exported() { if (controls.failExport) throw Error('export failed'); },
      place() {
        if (controls.failPlace) throw Error('place failed');
        let left = 0, top = 0, width = controls.placedSize[0], height = controls.placedSize[1];
        document.activeLayer = {
          get bounds() { return [left, top, left + width, top + height]; },
          rasterize() { controls.rasterized += 1; },
          resize(horizontal, vertical) { controls.transforms.push([horizontal, vertical]); width *= horizontal / 100; height *= vertical / 100; },
          translate(horizontal, vertical) { left += horizontal; top += vertical; },
          move(target, placement) { controls.moves.push([target, placement]); }
        };
        document.layers.push(document.activeLayer);
      },
      mask() { masks.push(document.selection.shape); }
    }
  });
  document.suspendHistory = (name, code) => vm.runInContext(code, context);
  vm.runInContext(source.replace(/\}\(\)\);\s*$/, `
    useAcceleratedPlayback = function () {};
    exportCroppedInPlace = __test.exported;
    placeFile = __test.place;
    makeRevealSelectionMask = __test.mask;
  }());`), context);
  return { api: context.AIGCSelectionRefiner, context, document, other, channels, masks, controls };
}

test('selection return uses equal horizontal and vertical scale even for a mismatched result ratio', () => {
  const current = harness();
  const exported = JSON.parse(current.api.exportSelection()).data;
  const target = { left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100 };
  const result = JSON.parse(current.api.placeResult('/result.png', target, exported.selectionChannelName, 11, []));
  assert.equal(result.ok, true);
  assert.deepEqual(current.controls.transforms, [[200, 200]]);
  assert.deepEqual(current.document.activeLayer.bounds, [10, -30, 210, 170]);
  assert.deepEqual(current.masks, ['lasso-A']);
});

test('selection return rasterizes the placed file before measuring and resizing it', () => {
  const current = harness();
  const exported = JSON.parse(current.api.exportSelection()).data;
  const result = JSON.parse(current.api.placeResult('/result.png', exported.selection, exported.selectionChannelName, 11, []));
  assert.equal(result.ok, true);
  assert.equal(current.controls.rasterized, 1);
});

test('selection return moves the generated layer into the originating artboard', () => {
  const current = harness();
  const artboard = { id: 77, name: 'Artboard 1', typename: 'LayerSet', artboardEnabled: true, bounds: [0, 0, 500, 500] };
  current.document.layerSets.push(artboard);
  const exported = JSON.parse(current.api.exportSelection()).data;

  assert.deepEqual(exported.artboard, { id: 77, name: 'Artboard 1' });
  const result = JSON.parse(current.api.placeResult('/image.png', exported.selection, exported.selectionChannelName, exported.documentId, [], exported.source, exported.artboard));

  assert.equal(result.ok, true);
  assert.equal(current.controls.moves.length, 1);
  assert.equal(current.controls.moves[0][0], artboard);
  assert.equal(current.controls.moves[0][1], 'inside');
});

test('resized source PSD is rejected before placing either selection or layered results', () => {
  const current = harness();
  const exported = JSON.parse(current.api.exportSelection()).data;
  current.document.width = 500;
  current.context.app.activeDocument = current.other;
  const selection = JSON.parse(current.api.placeResult('/result.png', exported.selection, exported.selectionChannelName, 11, [], exported.source));
  assert.equal(selection.ok, false);
  assert.match(selection.error, /尺寸/);
  assert.equal(current.context.app.activeDocument, current.other);
  const layered = JSON.parse(current.api.placeLayeredResult([{ path: '/result.png' }], 11, 'batch', exported.source));
  assert.equal(layered.ok, false);
  assert.match(layered.error, /尺寸/);
  assert.equal(current.context.app.activeDocument, current.other);
  assert.equal(current.masks.length, 0);
});

test('concurrent same-bounds selections return with their own captured shapes', () => {
  const current = harness();
  const first = JSON.parse(current.api.exportSelection()).data;
  assert.ok(first.selectionChannelName);
  current.document.selection.shape = 'lasso-B';
  const second = JSON.parse(current.api.exportSelection()).data;
  assert.notEqual(first.selectionChannelName, second.selectionChannelName);
  current.context.app.activeDocument = current.other;
  const placed = JSON.parse(current.api.placeResult('/result.png', first.selection, first.selectionChannelName, first.documentId, []));
  assert.equal(placed.ok, true);
  assert.deepEqual(current.masks, ['lasso-A']);
  assert.equal(current.document.selection.shape, 'lasso-B');
  assert.equal(current.context.app.activeDocument, current.other);
  assert.equal(current.channels.length, 1);
  assert.equal(current.channels[0].name, second.selectionChannelName);
  current.api.placeResult('/second.png', second.selection, second.selectionChannelName, second.documentId, []);
  assert.deepEqual(current.masks, ['lasso-A', 'lasso-B']);
  assert.equal(current.channels.length, 0);
});

test('Action Manager identity binds results even when Document.id is unavailable', () => {
  const current = harness();
  delete current.document.id;
  delete current.other.id;
  const exported = JSON.parse(current.api.exportSelection()).data;
  assert.equal(exported.documentId, 11);
  current.context.app.activeDocument = current.other;
  const result = JSON.parse(current.api.placeResult('/image.png', exported.selection, exported.selectionChannelName, exported.documentId, []));
  assert.equal(result.ok, true);
  assert.deepEqual(current.masks, ['lasso-A']);
  assert.equal(current.context.app.activeDocument, current.other);
});

test('missing or closed document identity fails without using the active document', () => {
  for (const identity of [undefined, null, '', 0, 'bad', 999]) {
    const current = harness();
    const exported = JSON.parse(current.api.exportSelection()).data;
    const result = JSON.parse(current.api.placeResult('/image.png', exported.selection, exported.selectionChannelName, identity, []));
    assert.equal(result.ok, false, String(identity));
    assert.equal(current.masks.length, 0);
    assert.equal(current.context.app.activeDocument, current.document);
  }
});

test('export bound to the guide document ignores another currently active PSD', () => {
  const current = harness();
  delete current.document.id;
  current.context.app.activeDocument = current.other;
  const exported = JSON.parse(current.api.exportDocument(11));
  assert.equal(exported.ok, true);
  assert.equal(exported.data.documentId, 11);
  assert.equal(exported.data.source.width, 1000);
  assert.equal(current.context.app.activeDocument, current.other);
});

test('missing task snapshot refuses placement instead of substituting current selection', () => {
  const current = harness();
  const result = JSON.parse(current.api.placeResult('/result.png', { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }, 'missing-snapshot', 11, []));
  assert.equal(result.ok, false);
  assert.equal(current.masks.length, 0);
  assert.equal(current.channels.length, 0);
  assert.equal(current.document.selection.shape, 'lasso-A');
});

test('export and placement failures do not leak task or recovery channels', () => {
  const current = harness();
  current.controls.failExport = true;
  assert.equal(JSON.parse(current.api.exportSelection()).ok, false);
  assert.equal(current.channels.length, 0);
  current.controls.failExport = false;
  const exported = JSON.parse(current.api.exportSelection()).data;
  current.controls.failPlace = true;
  current.document.selection.shape = 'new-selection';
  const result = JSON.parse(current.api.placeResult('/result.png', exported.selection, exported.selectionChannelName, 11, []));
  assert.equal(result.ok, false);
  assert.equal(current.channels.length, 1);
  assert.equal(current.channels[0].name, exported.selectionChannelName);
  assert.equal(current.document.selection.shape, 'new-selection');
  current.api.discardSelection(exported.selectionChannelName, exported.documentId);
  assert.equal(current.channels.length, 0);
});

test('discard targets the originating document and restores the active document', () => {
  const current = harness();
  const exported = JSON.parse(current.api.exportSelection()).data;
  assert.equal(current.channels.length, 1);
  current.context.app.activeDocument = current.other;
  const discarded = JSON.parse(current.api.discardSelection(exported.selectionChannelName, exported.documentId));
  assert.equal(discarded.data.removed, true);
  assert.equal(current.channels.length, 0);
  assert.equal(current.context.app.activeDocument, current.other);
});

test('replaying a completed task id does not place a duplicate selection layer', () => {
  const current = harness();
  const exported = JSON.parse(current.api.exportSelection()).data;
  const first = JSON.parse(current.api.placeResult('/first.png', exported.selection, exported.selectionChannelName, exported.documentId, [], exported.source, null, 'selection:trace-123'));
  const second = JSON.parse(current.api.placeResult('/second.png', exported.selection, exported.selectionChannelName, exported.documentId, [], exported.source, null, 'selection:trace-123'));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.data.alreadyPlaced, true);
  assert.equal(current.document.layers.length, 1);
  assert.equal(current.masks.length, 1);
});

test('panel releases the task snapshot after completion or failure', () => {
  const main = fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/js/main.js'), 'utf8');
  assert.match(main, /evalHost\("discardSelection", \[context\.selectionChannelName, context\.documentId\]\)/);
});
