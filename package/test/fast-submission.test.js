const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const payload = path.join(__dirname, '../AIGCSelectionRefiner');

function panelHarness() {
  const calls = [];
  const panel = vm.createContext({ require, Buffer, AIGCGateway: require('../AIGCSelectionRefiner/js/api-client'), CSInterface: function () {},
    window: { addEventListener() {} }, localStorage: { getItem() {}, setItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(payload, 'js/main.js'), 'utf8'), panel);
  const captured = { documentId: 42, documentName: 'source.psd', historyStamp: '2:selection',
    source: { width: 10000, height: 8000 }, selection: { left: -20, top: 60, width: 3000, height: 2000 }, artboard: { id: 8 } };
  panel.getBackgroundBridge = () => ({ waitReady: async () => {}, sessionId: () => 'original-session',
    snapshot: async () => { calls.push('snapshot'); return { path: 'pixels', timing: {} }; },
    capture: async () => { calls.push('binary-mask-capture'); } });
  panel.preparePixelSnapshot = async () => {};
  panel.evalHost = async (method, args) => {
    calls.push(method);
    assert.equal(method, 'prepareSubmission');
    assert.equal(args[0].reservation.name, 'result #1');
    assert.equal(args[0].reservation.id, 'unique-slot');
    return { ...captured, imagePath: 'snapshot.png', slot: { layerId: 77, parentId: 8,
      name: 'result #1', reservationId: 'unique-slot', maskPrepared: true } };
  };
  return { panel, calls, captured };
}

test('selection submission prepares once then reads pixels without full-resolution mask or PNG export', async () => {
  const current = panelHarness();
  const result = await current.panel.exportCapturedSelection('result #1', 'unique-slot');
  assert.deepEqual(current.calls, ['prepareSubmission', 'snapshot']);
  assert.equal(result.documentId, 42);
  assert.equal(result.source.backgroundSessionId, 'original-session');
  assert.equal(result.slot.parentId, 8);
  assert.equal(result.slot.maskPrepared, true);
  assert.equal(result.selectionMaskPath, undefined);
});

test('a missing destination stops submission before uploading rather than losing the return slot', async () => {
  const current = panelHarness();
  const original = current.panel.evalHost;
  current.panel.evalHost = async (method, args) => {
    const value = await original(method, args);
    if (method === 'prepareSubmission') delete value.slot;
    return value;
  };
  await assert.rejects(current.panel.exportCapturedSelection('result #1', 'unique-slot'), /目标图层|蒙版/);
});

test('switching windows during image preparation does not trigger a second active-document reservation', async () => {
  const current = panelHarness();
  const elements = { prompt: { value: 'refine' }, cleanupText: { checked: true } };
  current.panel.getElement = identity => elements[identity];
  current.panel.connected = true;
  current.panel.getSelectedModelKey = () => 'image-model';
  current.panel.getSelectedModel = () => ({});
  current.panel.readParameterValues = () => ({});
  current.panel.saveSettings = current.panel.updateControls = current.panel.setStatus = current.panel.removeFile = () => {};
  current.panel.scheduleTaskRecovery = () => {};
  current.panel.prepareExportedImage = async context => { current.calls.push('switch-window'); return context; };
  current.panel.getBackgroundReturn = () => ({ reserve: async () => { throw Error('late reservation of active window'); } });
  current.panel.prepareSelectionUpload = async context => context.imagePath;
  current.panel.uploadReferenceImages = async () => [];
  current.panel.gatewayClient = {
    uploadSelection: async () => 'uploaded-image',
    createImage: async () => { current.calls.push('generation'); return 'original-paid-trace'; }
  };
  current.panel.processSelectionPendingTask = async saved => {
    assert.equal(saved.context.documentId, 42);
    assert.equal(saved.context.slot.layerId, 77);
    assert.equal(saved.traceId, 'original-paid-trace');
  };
  current.panel.evalHost = async (method, args) => {
    current.calls.push(method);
    return { ...current.captured, imagePath: 'snapshot.png', slot: { layerId: 77, parentId: 8,
      name: args[0].reservation.name, reservationId: args[0].reservation.id, maskPrepared: true } };
  };
  await current.panel.runGeneration();
  assert.deepEqual(current.calls, ['prepareSubmission', 'snapshot', 'switch-window', 'generation']);
});

function hostHarness(options = {}) {
  const actions = [];
  let host;
  let nextIdentity = 70;
  let selected = options.selected || [7, 9];
  const source = { id: 42, name: 'original.psd', width: 400, height: 300,
    mode: 'rgb', bitsPerChannel: 8, historyStates: [{}, {}], activeHistoryState: { name: 'selection' },
    selection: { bounds: [20, 60, 100, 200] }, activeLayer: { id: 7 }, activeChannels: ['RGB'], layerSets: [],
    suspendHistory(name, script) { actions.push(name); vm.runInContext(script, host); },
    exportDocument() { actions.push('export'); }, saveAs() { actions.push('export'); },
    artLayers: { add() { const layer = { id: ++nextIdentity, parent: source }; source.activeLayer = layer; return layer; } } };
  const board = { id: 8, name: 'board', typename: 'LayerSet', artboardEnabled: true,
    artLayers: { add() { const layer = source.artLayers.add(); layer.parent = board; return layer; } } };
  source.layerSets = [board];
  source.layerSets.add = () => {
    const group = { id: ++nextIdentity, parent: source, layers: [], artLayers: {
      add() { const layer = source.artLayers.add(); layer.parent = group; group.layers.unshift(layer); return layer; }
    } };
    source.layerSets.unshift(group);
    return group;
  };
  function Descriptor() { this.values = {}; }
  for (const name of ['putClass', 'putReference', 'putEnumerated', 'putBoolean']) Descriptor.prototype[name] = function (key, value) { this.values[key] = value; };
  function Reference() {}
  for (const name of ['putProperty', 'putEnumerated', 'putIdentifier']) Reference.prototype[name] = function (kind, value) {
    if (kind === 'Prpr') this.property = value;
    if (kind === 'layer') this.layer = value;
  };
  const app = { documents: [source], activeDocument: source, preferences: {}, displayDialogs: 'original-dialogs' };
  host = vm.createContext({ app, ActionDescriptor: Descriptor, ActionReference: Reference,
    charIDToTypeID: value => value, stringIDToTypeID: value => value,
    DialogModes: { NO: 'no' }, Units: { PIXELS: 'px' }, DocumentMode: { RGB: 'rgb' },
    BitsPerChannelType: { EIGHT: 8, THIRTYTWO: 32 }, ExportOptionsSaveForWeb: function () {}, PNGSaveOptions: function () {},
    SaveDocumentType: { PNG: 'png' }, ExportType: { SAVEFORWEB: 'web' }, Extension: { LOWERCASE: 'lower' },
    File: function (filename) { this.fsName = filename; this.exists = true; this.remove = () => actions.push('remove-file'); },
    Folder: { temp: { fsName: '/temp' } },
    executeActionGet(reference) {
      return { getInteger: key => key === 'documentID' ? 42 : 0, hasKey: key => key === 'targetLayersIDs',
        getList: () => ({ count: selected.length, getReference: index => ({ getIdentifier: () => selected[index] }) }),
        getObjectValue: () => ({ getObjectValue: () => ({ getUnitDoubleValue: key => ({ left: -100, top: 0, right: 300, bottom: 300 })[key] }) }) };
    },
    executeAction(command, descriptor) {
      if (command === 'Mk  ') { actions.push('native-mask'); source.activeChannels = ['mask']; }
      if (command === 'slct') { actions.push('restore-selection'); }
      if (command === 'selectNoLayers') {
        if (options.rejectEmptySelection || source.activeChannels[0] === 'mask') throw Error('selectNoLayers unavailable');
        selected = [];
        actions.push('restore-empty-selection');
      }
    } });
  vm.runInContext(fs.readFileSync(path.join(payload, 'host/AIGCSelectionRefiner.jsx'), 'utf8'), host);
  const context = { documentId: 42, source: { width: 400, height: 300, backgroundSessionId: 'session' }, historyStamp: '2:selection',
    selection: { left: 20, top: 60, width: 80, height: 140 }, artboard: { id: 8, name: 'board' },
    reservation: { name: 'result', id: 'a'.repeat(32) } };
  return { host, source, board, app, context, actions };
}

test('native reservation uses the original selection and artboard inside the same export transaction', () => {
  const current = hostHarness();
  const result = JSON.parse(current.host.AIGCSelectionRefiner.exportSelection(current.context));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.data.slot, { layerId: 71, parentId: 8, groupId: null, name: 'result', reservationId: 'a'.repeat(32), maskPrepared: true });
  assert.deepEqual(current.actions, ['export', 'AIGC 预建结果图层', 'native-mask', 'restore-selection', 'restore-selection']);
  assert.deepEqual(current.source.activeChannels, ['RGB']);
  assert.equal(current.app.activeDocument, current.source);
  assert.equal(current.app.displayDialogs, 'original-dialogs');
});

test('mask failure rolls back the slot and removes the incomplete snapshot instead of submitting', () => {
  const current = hostHarness();
  const before = current.source.activeHistoryState;
  current.host.executeAction = command => { if (command === 'Mk  ') throw Error('mask failed'); };
  const result = JSON.parse(current.host.AIGCSelectionRefiner.exportSelection(current.context));
  assert.equal(result.ok, false);
  assert.match(result.error, /mask failed/);
  assert.equal(current.source.activeHistoryState, before);
  assert.ok(current.actions.includes('remove-file'));
});

test('preparation reserves the original selection without any Photoshop PNG export and restores channels', () => {
  const current = hostHarness();
  const result = JSON.parse(current.host.AIGCSelectionRefiner.prepareSubmission({ selection: true,
    reservation: current.context.reservation }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.documentId, 42);
  assert.equal(result.data.selection.left, 20);
  assert.equal(result.data.slot.parentId, 8);
  assert.equal(result.data.slot.maskPrepared, true);
  assert.deepEqual(current.actions, ['AIGC 预建结果图层', 'native-mask', 'restore-selection', 'restore-selection']);
  assert.deepEqual(current.source.activeChannels, ['RGB']);
  assert.equal(current.app.activeDocument, current.source);
  assert.equal(current.app.displayDialogs, 'original-dialogs');
  assert.ok(result.data.timing.hostMs >= 0);
});

test('empty layer selection never invokes an unavailable deselect command after reserving a mask', () => {
  const current = hostHarness({ selected: [], rejectEmptySelection: true });
  const result = JSON.parse(current.host.AIGCSelectionRefiner.prepareSubmission({ selection: true,
    reservation: current.context.reservation }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.slot.maskPrepared, true);
  assert.deepEqual(current.source.activeChannels, ['RGB']);
  assert.ok(!current.actions.includes('restore-empty-selection'));
});

test('restoring an empty selection switches away from the mask channel before deselecting layers', () => {
  const current = hostHarness({ selected: [] });
  const originalGet = current.host.executeActionGet;
  current.host.executeActionGet = reference => {
    if (reference.property === 'targetLayersIDs' && current.source.activeLayer.id !== 7) {
      return { hasKey: () => true, getList: () => ({ count: 1,
        getReference: () => ({ getIdentifier: () => current.source.activeLayer.id }) }) };
    }
    return originalGet(reference);
  };
  const result = JSON.parse(current.host.AIGCSelectionRefiner.prepareSubmission({ selection: true,
    reservation: current.context.reservation }));
  assert.equal(result.ok, true, result.error);
  assert.ok(current.actions.includes('restore-empty-selection'));
  assert.deepEqual(current.source.activeChannels, ['RGB']);
});

test('whole-document layer preparation needs no selection and reserves top-to-bottom ordering', () => {
  const current = hostHarness();
  Object.defineProperty(current.source.selection, 'bounds', { get() { throw Error('no selection'); } });
  const result = JSON.parse(current.host.AIGCSelectionRefiner.prepareSubmission({ selection: false,
    reservation: { names: ['foreground', 'middle', 'background'], groupName: 'layers', id: 'b'.repeat(32) } }));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.selection, null);
  assert.equal(result.data.artboard, null);
  assert.deepEqual(result.data.slots.map(slot => slot.name), ['foreground', 'middle', 'background']);
  assert.deepEqual(current.source.layerSets[0].layers.map(layer => layer.name), ['foreground', 'middle', 'background']);
  assert.ok(result.data.slots.every(slot => slot.parentId === 71 && slot.groupId === 71 && !slot.maskPrepared));
  assert.deepEqual(current.actions, ['AIGC 预建结果图层', 'restore-selection', 'restore-selection']);
});

test('native preparation failure rolls back and restores channels without generating or exporting', () => {
  const current = hostHarness();
  const before = current.source.activeHistoryState;
  current.host.executeAction = command => { if (command === 'Mk  ') throw Error('native mask failed'); };
  const result = JSON.parse(current.host.AIGCSelectionRefiner.prepareSubmission({ selection: true,
    reservation: current.context.reservation }));
  assert.equal(result.ok, false);
  assert.match(result.error, /native mask failed/);
  assert.equal(current.source.activeHistoryState, before);
  assert.deepEqual(current.source.activeChannels, ['RGB']);
  assert.equal(current.app.displayDialogs, 'original-dialogs');
  assert.ok(!current.actions.includes('export'));
});

test('changed helper session stops before encoding or uploading a snapshot and clears task temporary files', async () => {
  const current = panelHarness();
  const deleted = [];
  let session = 'original-session';
  current.panel.removeFile = filename => deleted.push(filename);
  current.panel.getBackgroundBridge = () => ({ sessionId: () => session,
    snapshot: async () => { session = 'changed-session'; return { path: 'pixels' }; } });
  current.panel.preparePixelSnapshot = async () => { throw Error('must not encode stale snapshot'); };
  await assert.rejects(current.panel.exportCapturedSelection('result #1', 'unique-slot'), /会话/);
  assert.equal(deleted.length, 2);
  assert.ok(deleted.some(filename => filename.endsWith('.rgba')));
  assert.ok(deleted.some(filename => filename.endsWith('.png')));
});
