const assert = require('node:assert/strict');
const test = require('node:test');
const { createReservation } = require('../uxp-helper/reservation.js');

function harness() {
  let identity = 100;
  const original = { id: 7, name: 'original' };
  const document = { id: 11, width: 100, height: 80, layers: [original], activeLayers: [original] };
  function makeLayer(name, parent, grouped) {
    const layer = { id: ++identity, name, parent, layers: grouped ? [] : undefined };
    layer.move = async (relative, placement) => {
      layer.parent.layers.splice(layer.parent.layers.indexOf(layer), 1);
      if (placement === 'inside') { layer.parent = relative; relative.layers.unshift(layer); }
      else {
        layer.parent = relative.parent;
        layer.parent.layers.splice(layer.parent.layers.indexOf(relative) + (placement === 'after' ? 1 : 0), 0, layer);
      }
    };
    parent.layers.unshift(layer);
    document.activeLayers = [layer];
    return layer;
  }
  document.createPixelLayer = async options => makeLayer(options.name, document);
  document.createLayerGroup = async options => makeLayer(options.name, document, true);
  const commits = [];
  const photoshop = { app: { documents: [document], activeDocument: document },
    action: { batchPlay: async commands => {
      const selectedIds = commands[0]._target.map(target => target._id);
      document.activeLayers = selectedIds.map(identity => identity === original.id ? original : null);
      return [{}];
    } },
    constants: { ElementPlacement: { PLACEINSIDE: 'inside', PLACEAFTER: 'after' } },
    core: { executeAsModal: async operation => operation({ hostControl: {
      suspendHistory: async () => 55,
      resumeHistory: async (value, commit) => commits.push(commit)
    } }) } };
  const args = { documentId: 11, source: { width: 100, height: 80, backgroundSessionId: 'session' },
    reservationId: 'reservation-original', names: ['near', 'middle', 'background'], groupName: 'new AI group' };
  return { document, original, args, photoshop, commits, makeLayer, reserve: createReservation(photoshop, 'session') };
}

test('prepares transparent layer slots in template order and restores the original active layer', async () => {
  const current = harness();
  const result = await current.reserve(current.args);
  const group = current.document.layers.find(layer => layer.name === 'new AI group');
  assert.deepEqual(group.layers.map(layer => layer.name), ['near', 'middle', 'background']);
  assert.deepEqual(current.document.activeLayers, [current.original]);
  assert.deepEqual(result.slots.map(slot => slot.layerId), group.layers.map(layer => layer.id));
  assert.ok(result.slots.every(slot => slot.parentId === group.id && slot.reservationId === current.args.reservationId));
});

test('preparation refuses an inactive submission document instead of selecting it', async () => {
  const current = harness();
  current.photoshop.app.activeDocument = { id: 99 };
  await assert.rejects(current.reserve(current.args), /当前|活动/);
  assert.deepEqual(current.document.layers, [current.original]);
});

test('prepares a single result inside the captured artboard', async () => {
  const current = harness();
  const artboard = current.makeLayer('board', current.document, true);
  current.document.activeLayers = [current.original];
  const result = await current.reserve({ ...current.args, names: ['selection result'], groupName: null, artboard: { id: artboard.id } });
  assert.equal(result.slots[0].parentId, artboard.id);
  assert.equal(artboard.layers[0].name, 'selection result');
});

test('preparation validates source identity and unique template names before editing', async () => {
  const current = harness();
  await assert.rejects(current.reserve({ ...current.args, source: { ...current.args.source, backgroundSessionId: 'old' } }), /会话/);
  await assert.rejects(current.reserve({ ...current.args, names: ['near', 'near'] }), /名称/);
  assert.equal(current.commits.length, 0);
});

test('failed preparation rolls back instead of returning partial slots', async () => {
  const current = harness();
  current.document.createPixelLayer = async () => { throw Error('create failed'); };
  await assert.rejects(current.reserve(current.args), /create failed/);
  assert.deepEqual(current.commits, [false]);
  assert.deepEqual(current.document.activeLayers, [current.original]);
});

test('restores selected layers through the supported PS2024 action API, not a read-only DOM setter', async () => {
  const current = harness();
  let selected = [current.original];
  Object.defineProperty(current.document, 'activeLayers', { get: () => selected, set: () => { throw Error('activeLayers is read-only in PS2024'); } });
  current.document.createPixelLayer = async options => { const layer = current.makeLayer(options.name, current.document); return layer; };
  current.makeLayer = (name, parent, grouped) => {
    const layer = { id: 202, name, parent, layers: grouped ? [] : undefined };
    parent.layers.push(layer);
    selected = [layer];
    return layer;
  };
  current.photoshop.action.batchPlay = async commands => {
    assert.ok(commands.every(command => command._target.every(target => target._ref === 'layer')));
    assert.deepEqual(commands[0].selectionModifier, { _enum: 'selectionModifierType', _value: '0' });
    selected = [current.original];
    return [{}];
  };
  await current.reserve({ ...current.args, names: ['selection'], groupName: null });
  assert.deepEqual(selected, [current.original]);
});

test('restores every originally selected layer without selecting a document', async () => {
  const current = harness();
  const other = current.makeLayer('another original', current.document);
  current.document.activeLayers = [current.original, other];
  current.photoshop.action.batchPlay = async commands => {
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0]._target, [{ _ref: 'layer', _id: current.original.id }, { _ref: 'layer', _id: other.id }]);
    current.document.activeLayers = [current.original, other];
    return [{}];
  };
  await current.reserve(current.args);
  assert.deepEqual(current.document.activeLayers, [current.original, other]);
});

test('restores a document with no selected layers instead of leaving the result slot selected', async () => {
  const current = harness();
  current.document.activeLayers = [];
  current.photoshop.action.batchPlay = async commands => {
    assert.equal(commands[0]._obj, 'selectNoLayers');
    assert.deepEqual(commands[0]._target, [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]);
    current.document.activeLayers = [];
    return [{}];
  };
  await current.reserve(current.args);
  assert.deepEqual(current.document.activeLayers, []);
});

test('selection mask is created on the active submission document before later background pixel return', async () => {
  const current = harness();
  const calls = [];
  let insideModal = false;
  const execute = current.photoshop.core.executeAsModal;
  current.photoshop.core.executeAsModal = async operation => { insideModal = true; try { return await execute(operation); } finally { insideModal = false; } };
  current.photoshop.imaging = {
    createImageDataFromBuffer: async (bytes, options) => { assert.equal(options.components, 1); return { dispose() { calls.push('dispose'); } }; },
    putLayerMask: async options => {
      assert.equal(current.photoshop.app.activeDocument.id, options.documentID);
      assert.deepEqual(options.targetBounds, { left: -3, top: 7 });
      calls.push('mask');
    }
  };
  const reserve = createReservation(current.photoshop, 'session', async () => { assert.equal(insideModal, false); return new Uint8Array([255, 128, 0, 255]); });
  const result = await reserve({ ...current.args, names: ['selection'], groupName: null, mask: 'resource', target: { left: -3, top: 7, width: 2, height: 2 } });
  assert.equal(result.slots[0].maskPrepared, true);
  assert.deepEqual(calls, ['mask', 'dispose']);
  assert.deepEqual(current.document.activeLayers, [current.original]);
});
