const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../cep/AIGCSelectionRefiner/host/AIGCSelectionRefiner.jsx'), 'utf8');

function harness() {
  const controls = { failResize: new Set(), failMove: new Set(), failGroup: false };
  const document = { width: 1000, height: 800, layers: [], layerSets: [] };
  function detach(layer) {
    const siblings = layer.parent.layers;
    const index = siblings.indexOf(layer);
    if (index >= 0) siblings.splice(index, 1);
  }
  function addLayer(name, group) {
    const layer = {
      name, parent: document,
      remove() {
        detach(this);
        const index = document.layerSets.indexOf(this);
        if (index >= 0) document.layerSets.splice(index, 1);
      },
      move(relative, placement) {
        if (controls.failMove.has(this.name)) throw Error('move failed');
        detach(this);
        this.parent = placement === 'inside' ? relative : relative.parent;
        const siblings = this.parent.layers;
        const index = placement === 'inside' ? 0 : siblings.indexOf(relative) + (placement === 'after' ? 1 : 0);
        siblings.splice(index, 0, this);
      }
    };
    if (group) layer.layers = [];
    document.layers.unshift(layer);
    document.activeLayer = layer;
    return layer;
  }
  document.layerSets.add = () => {
    if (controls.failGroup) throw Error('group failed');
    const group = addLayer('new group', true);
    document.layerSets.push(group);
    return group;
  };
  const original = addLayer('original');
  const context = vm.createContext({
    app: { documents: [document], activeDocument: document, displayDialogs: 1, preferences: { rulerUnits: 'inches' } },
    DialogModes: { NO: 0 }, Units: { PIXELS: 'px' },
    ElementPlacement: { INSIDE: 'inside', PLACEBEFORE: 'before', PLACEAFTER: 'after' },
    File: function (name) { this.fsName = name; },
    charIDToTypeID: value => value, stringIDToTypeID: value => value,
    ActionReference: function () { this.putProperty = () => {}; this.putEnumerated = () => {}; },
    executeActionGet: () => ({ getInteger: () => 11 }),
    __test: {
      place(file) { addLayer(path.basename(file.fsName, '.png')); },
      resize(layer) { if (controls.failResize.has(layer.name)) throw Error('resize failed'); }
    }
  });
  document.suspendHistory = (name, code) => vm.runInContext(code, context);
  vm.runInContext(source.replace(/\}\(\)\);\s*$/, `
    useAcceleratedPlayback = function () {};
    placeFile = __test.place;
    resizeAndMoveLayer = __test.resize;
    healResultRegions = function () { return []; };
  }());`), context);
  function place(names, order = names) {
    const layers = names.map(name => ({ name, path: '/' + name + '.png', belowName: order[order.indexOf(name) - 1] || '' }));
    return JSON.parse(context.AIGCSelectionRefiner.placeLayeredResult(layers, 11, 'batch', { width: 1000, height: 800 }, order));
  }
  function names() {
    const group = document.layerSets.find(layer => layer.name === 'batch');
    return group ? group.layers.map(layer => layer.name) : [];
  }
  return { controls, document, original, place, names };
}

test('failed resize removes only the newly placed layer before retry', () => {
  const current = harness();
  current.controls.failResize.add('ground');
  const failed = current.place(['ground']);
  assert.equal(failed.ok, true);
  assert.deepEqual(failed.data.placed, []);
  assert.equal(failed.data.failures.length, 1);
  assert.deepEqual(current.document.layers.filter(layer => !layer.layers), [current.original]);
  current.controls.failResize.clear();
  assert.deepEqual(current.place(['ground']).data.placed, ['ground']);
  assert.deepEqual(current.names(), ['ground']);
  assert.deepEqual(current.document.layers.filter(layer => !layer.layers), [current.original]);
});

test('missing middle layer and its later retry preserve the full stacking order', () => {
  const current = harness();
  const order = ['background', 'middle', 'foreground'];
  current.controls.failResize.add('middle');
  assert.deepEqual(current.place(order, order).data.placed, ['background', 'foreground']);
  assert.deepEqual(current.names(), ['foreground', 'background']);
  current.controls.failResize.clear();
  assert.deepEqual(current.place(['middle'], order).data.placed, ['middle']);
  assert.deepEqual(current.names(), ['foreground', 'middle', 'background']);
});

test('replaying an already placed layer name does not create a duplicate', () => {
  const current = harness();
  assert.deepEqual(current.place(['ground']).data.placed, ['ground']);
  assert.deepEqual(current.place(['ground']).data.placed, ['ground']);
  assert.deepEqual(current.names(), ['ground']);
});

test('a grouping move failure keeps the layer retryable without leaving an orphan', () => {
  const current = harness();
  const order = ['background', 'middle', 'foreground'];
  current.controls.failMove.add('middle');
  const failed = current.place(order, order);
  assert.deepEqual(failed.data.placed, ['background', 'foreground']);
  assert.equal(failed.data.failures.length, 1);
  assert.deepEqual(current.names(), ['foreground', 'background']);
  assert.deepEqual(current.document.layers.filter(layer => !layer.layers), [current.original]);
  current.controls.failMove.clear();
  assert.deepEqual(current.place(['middle'], order).data.placed, ['middle']);
  assert.deepEqual(current.names(), ['foreground', 'middle', 'background']);
});

test('group creation failure never reports ungrouped layers as successfully returned', () => {
  const current = harness();
  current.controls.failGroup = true;
  const failed = current.place(['background', 'foreground']);
  assert.deepEqual(failed.data.placed, []);
  assert.equal(failed.data.failures.length, 2);
  assert.deepEqual(current.document.layers, [current.original]);
  current.controls.failGroup = false;
  assert.deepEqual(current.place(['background', 'foreground']).data.placed, ['background', 'foreground']);
  assert.deepEqual(current.names(), ['foreground', 'background']);
});
