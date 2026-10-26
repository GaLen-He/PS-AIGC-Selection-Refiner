const assert = require('node:assert/strict');
const test = require('node:test');
const { createWriter } = require('../uxp-helper/writer.js');

function harness() {
  const calls = [];
  const foreground = { id: 22, width: 120, height: 90, layers: [] };
  const target = { id: 11, width: 100, height: 80, layers: [] };
  let nextId = 100;
  function layer(name, parent, group) {
    const item = { id: ++nextId, name, layers: group ? [] : undefined, parent };
    item.move = async (relative, position) => {
      calls.push(['move', item.id, relative.id, position]);
      const old = item.parent.layers;
      old.splice(old.indexOf(item), 1);
      if (position === 'inside') { item.parent = relative; relative.layers.push(item); }
      else {
        item.parent = relative.parent;
        const offset = item.parent.layers.indexOf(relative) + (position === 'after' ? 1 : 0);
        item.parent.layers.splice(offset, 0, item);
      }
    };
    parent.layers.push(item);
    return item;
  }
  target.createPixelLayer = async options => { calls.push(['create', target.id, options.name]); return layer(options.name, target); };
  target.createLayerGroup = async options => layer(options.name, target, true);
  const photoshop = {
    app: { documents: [target, foreground], activeDocument: foreground },
    constants: { ElementPlacement: { PLACEINSIDE: 'inside', PLACEBEFORE: 'before', PLACEAFTER: 'after' } },
    core: { executeAsModal: async operation => operation({ hostControl: {
      suspendHistory: async options => { calls.push(['suspend', options.documentID]); return 55; },
      resumeHistory: async (identity, commit) => { calls.push(['resume', identity, commit]); }
    } }) },
    imaging: {
      createImageDataFromBuffer: async (bytes, options) => ({ ...options, bytes, dispose() { calls.push(['dispose']); } }),
      putPixels: async options => { calls.push(['pixels', options.documentID, options.layerID, options.targetBounds, options.replace]); },
      putLayerMask: async options => { calls.push(['mask', options.documentID, options.layerID, options.targetBounds, options.imageData.components]); }
    }
  };
  const assets = { pixels: new Uint8Array(16).fill(255), mask: new Uint8Array([255, 0, 255, 128]) };
  const slotLayer = layer('reserved result', target);
  return { calls, photoshop, target, foreground, layer, assets, slotLayer,
    writer: createWriter(photoshop, async (identity, offset, length) => assets[identity].slice(offset, offset + length)) };
}

function job(extra = {}) {
  return { documentId: 11, source: { width: 100, height: 80 }, taskId: 'selection-trace-unique', name: 'result',
    target: { left: -3, top: 7, width: 2, height: 2 }, pixels: 'pixels', mask: null,
    slot: { layerId: 101, parentId: 11, name: 'reserved result', reservationId: 'reservation-original' }, ...extra };
}

test('transparent results never call RGBA putPixels and write RGB plus combined selection alpha at exact edges', async () => {
  const current = harness();
  current.target.activeHistoryState = { id: 77 };
  current.assets.pixels.set([51, 102, 153, 128, 1, 2, 3, 255, 7, 8, 9, 0, 10, 11, 12, 64]);
  let modal = false;
  const execute = current.photoshop.core.executeAsModal;
  current.photoshop.core.executeAsModal = async (callback, options) => {
    modal = true;
    try { return await execute(callback, options); } finally { modal = false; }
  };
  current.photoshop.imaging.getLayerMask = async options => {
    assert.equal(modal, true, 'mask imaging must run inside a short modal scope');
    assert.equal(options.documentID, 11);
    assert.equal(options.layerID, 101);
    return { sourceBounds: { left: 98, top: 0, right: 100, bottom: 2 }, imageData: {
      width: 2, height: 2, components: 1, getData: async () => new Uint8Array([255, 128, 255, 255]), dispose() {}
    } };
  };
  const attempts = [];
  current.photoshop.imaging.putPixels = async options => {
    attempts.push(options);
    if (options.imageData.components === 4) throw Object.assign(Error('Photoshop Error. Code: -1'), { number: -1 });
  };
  let combined;
  current.photoshop.imaging.putLayerMask = async options => { combined = options; };
  const placed = await current.writer.place(job({ target: { left: 98, top: 0, width: 2, height: 2 },
    slot: { ...job().slot, maskPrepared: true } }));
  assert.equal(placed.placed, true);
  assert.deepEqual(attempts.map(item => item.imageData.components), [3]);
  assert.deepEqual(attempts[0].targetBounds, { left: 98, top: 0 });
  assert.deepEqual(Array.from(combined.imageData.bytes), [128, 128, 0, 64]);
  assert.deepEqual(combined.targetBounds, { left: 98, top: 0 });
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [true]);
});

test('cutout PNG without a prepared mask uses its own alpha as the layer mask and no RGBA write', async () => {
  const current = harness();
  current.assets.pixels.set([0, 0, 0, 0, 51, 102, 153, 255, 10, 20, 30, 127, 0, 0, 0, 0]);
  const components = [];
  let mask;
  current.photoshop.imaging.putPixels = async options => { components.push(options.imageData.components); };
  current.photoshop.imaging.putLayerMask = async options => { mask = options; };
  assert.equal((await current.writer.place(job())).placed, true);
  assert.deepEqual(components, [3]);
  assert.deepEqual(Array.from(mask.imageData.bytes), [0, 255, 127, 0]);
  assert.deepEqual(mask.targetBounds, { left: -3, top: 7 });
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
});

test('post-return cleanup rollback preserves committed pixels and retries cannot rewrite them', async () => {
  const current = harness();
  current.target.activeHistoryState = { id: 77 };
  const placed = await current.writer.place(job());
  assert.ok(placed.cleanupToken);
  current.photoshop.imaging.putPixels = async () => { throw Error('cleanup pixel failure'); };
  await assert.rejects(current.writer.cleanup({ ...job(), cleanupToken: placed.cleanupToken }), /cleanup/);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [true, false]);
  assert.equal((await current.writer.place(job())).alreadyPlaced, true);
});

test('post-return cleanup skips after document edits or a missing receipt without touching Photoshop', async () => {
  const current = harness();
  current.target.activeHistoryState = { id: 77 };
  const placed = await current.writer.place(job());
  current.target.activeHistoryState.id = 78;
  const count = current.calls.length;
  assert.equal((await current.writer.cleanup({ ...job(), cleanupToken: placed.cleanupToken })).cleaned, false);
  assert.equal((await current.writer.cleanup(job())).cleaned, false);
  assert.equal(current.calls.length, count);
});

test('transient native validation errors are recoverable instead of falsely blocking the document identity', async () => {
  const current = harness();
  let attempts = 0;
  Object.defineProperty(current.slotLayer, 'name', { get() {
    if (++attempts === 1) throw Object.freeze(Object.assign(Error('Photoshop Error. Code: -1'), { number: -1 }));
    return 'reserved result';
  } });
  await assert.rejects(current.writer.place(job()), error => error.phase === 'validate' && error.number === -1 && error.recoveryBlocked !== true);
  assert.equal((await current.writer.place(job())).placed, true);
});

test('pixel failure carries the exact phase and number even when rollback also fails', async () => {
  const current = harness();
  current.photoshop.imaging.putPixels = async () => { throw Object.assign(Error('Photoshop Error. Code: -1'), { number: -1 }); };
  current.photoshop.core.executeAsModal = async operation => operation({ hostControl: {
    suspendHistory: async () => 55,
    resumeHistory: async () => { throw Error('rollback failure'); }
  } });
  await assert.rejects(current.writer.place(job()), error => error.number === -1 && error.phase === 'putPixels' &&
    error.stripe === 0 && /rollback failure/.test(error.rollbackError));
});

test('native string pixel failure does not poison the queue for a later retry', async () => {
  const current = harness();
  const write = current.photoshop.imaging.putPixels;
  let attempts = 0;
  current.photoshop.imaging.putPixels = async options => {
    if (++attempts === 1) throw 'Error: Photoshop Error. Code: -1';
    return write(options);
  };
  const failed = current.writer.place(job());
  const next = current.writer.place(job());
  await assert.rejects(failed, /Code: -1/);
  assert.equal((await next).placed, true);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [false, true]);
});

test('non-extensible Photoshop errors preserve the original code, phase and rollback failure', async () => {
  const current = harness();
  current.photoshop.imaging.putPixels = async () => {
    throw Object.freeze(Object.assign(Error('Photoshop Error. Code: -1'), { number: -1 }));
  };
  current.photoshop.core.executeAsModal = async operation => operation({ hostControl: {
    suspendHistory: async () => 55,
    resumeHistory: async () => { throw 'rollback failure'; }
  } });
  await assert.rejects(current.writer.place(job()), error => error.number === -1 && error.phase === 'putPixels' &&
    error.stripe === 0 && error.rollbackError === 'rollback failure');
});

test('transparent and opaque PNG pixels use the same inactive-document return and retain alpha', async () => {
  const current = harness();
  current.assets.pixels.set([0, 0, 0, 0, 51, 102, 153, 255, 10, 20, 30, 127, 0, 0, 0, 0]);
  const images = [];
  current.photoshop.imaging.createImageDataFromBuffer = async (bytes, options) => {
    images.push({ bytes: Array.from(bytes), options });
    return { ...options, dispose() {} };
  };
  assert.equal((await current.writer.place(job())).placed, true);
  assert.deepEqual(images[0].bytes, [0, 0, 0, 51, 102, 153, 10, 20, 30, 0, 0, 0]);
  assert.equal(images[0].options.components, 3);
  assert.equal(images[1].options.components, 1);
  assert.deepEqual(images[1].bytes, [0, 255, 127, 0]);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
  current.assets.pixels.fill(255);
  const second = current.layer('second result', current.target);
  assert.equal((await current.writer.place(job({ taskId: 'opaque-result', slot: {
    layerId: second.id, name: second.name, parentId: 11, reservationId: 'opaque-reservation'
  } }))).placed, true);
  assert.deepEqual(images[2].bytes, Array(12).fill(255));
  assert.equal(images[2].options.components, 3);
  assert.equal(images.length, 3);
});

test('a modified reserved layer is a blocked recovery, not a transient Photoshop failure', async () => {
  const current = harness();
  current.slotLayer.name = 'user edited';
  await assert.rejects(current.writer.place(job()), error => error.recoveryBlocked === true && error.phase === 'validate');
});

test('pixel layers are never queried as groups through the native layers getter', async () => {
  const current = harness();
  current.photoshop.constants.LayerKind = { NORMAL: 'normal', GROUP: 'group' };
  current.slotLayer.kind = 'normal';
  Object.defineProperty(current.slotLayer, 'layers', { get() { throw Error('Photoshop Error. Code: -1'); } });
  assert.equal((await current.writer.place(job())).placed, true);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
});

test('return into an inactive PSD never invokes DOM operations that can activate and restore its window', async () => {
  const current = harness();
  let transientActivations = 0;
  const activatingCall = () => { transientActivations += 1; throw Error('DOM activates target window'); };
  current.target.createPixelLayer = activatingCall;
  current.target.createLayerGroup = activatingCall;
  current.slotLayer.move = activatingCall;
  current.slotLayer.delete = activatingCall;
  const name = current.slotLayer.name;
  Object.defineProperty(current.slotLayer, 'name', { get: () => name, set: activatingCall });
  await current.writer.place(job());
  assert.equal(transientActivations, 0);
  assert.equal(current.calls.filter(call => call[0] === 'pixels').length, 1);
});

test('all pixel transport finishes before the Photoshop write lock is acquired', async () => {
  const current = harness();
  let insideModal = false;
  const execute = current.photoshop.core.executeAsModal;
  current.photoshop.core.executeAsModal = async operation => {
    insideModal = true;
    try { return await execute(operation); } finally { insideModal = false; }
  };
  const writer = createWriter(current.photoshop, async (identity, offset, length) => {
    assert.equal(insideModal, false, 'network transfer must not hold Photoshop modal lock');
    return current.assets[identity].slice(offset, offset + length);
  });
  await writer.place(job());
});

test('a legacy job with no reserved destination is retained without creating or selecting anything', async () => {
  const current = harness();
  await assert.rejects(current.writer.place(job({ slot: null })), /预建|目标图层/);
  assert.equal(current.calls.length, 0);
});

test('deleted, renamed or reparented destinations cannot be mistaken for a new task target', async () => {
  const current = harness();
  await assert.rejects(current.writer.place(job({ slot: { layerId: 999, name: 'reserved result', parentId: 11, reservationId: 'reservation-original' } })), /目标图层/);
  current.slotLayer.name = 'user edited name';
  await assert.rejects(current.writer.place(job()), /目标图层/);
  assert.equal(current.calls.length, 0);
});

test('writes pixels to the original inactive document without selecting it or replacing its prepared mask', async () => {
  const current = harness();
  await current.writer.place(job());
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
  assert.equal(current.foreground.layers.length, 0);
  assert.equal(current.target.layers.length, 1);
  assert.deepEqual(current.calls.find(call => call[0] === 'pixels').slice(1), [11, 101, { left: -3, top: 7 }, true]);
  assert.equal(current.calls.filter(call => call[0] === 'mask').length, 0);
});

test('duplicate completed task does not create another layer', async () => {
  const current = harness();
  await current.writer.place(job());
  const response = await current.writer.place(job());
  assert.equal(response.alreadyPlaced, true);
  assert.equal(current.target.layers.length, 1);
});

test('different tasks with matching ID suffixes use independent reserved layers', async () => {
  const current = harness();
  const second = current.layer('second reserved result', current.target);
  await current.writer.place(job({ taskId: 'first-1234567890' }));
  await current.writer.place(job({ taskId: 'second-1234567890', slot: { layerId: second.id, parentId: 11, name: second.name, reservationId: 'second-reservation' } }));
  assert.equal(current.target.layers.length, 2);
  assert.notEqual(current.target.layers[0].name, current.target.layers[1].name);
});

test('an existing same-name PSD layer is not mistaken for a reserved destination', async () => {
  const current = harness();
  const original = current.layer('background', current.target);
  const request = job({ name: 'background', taskId: 'new-background', groupName: 'new AI group', mask: null });
  const response = await current.writer.place(request);
  assert.notEqual(response.alreadyPlaced, true);
  assert.equal(response.layerId, current.slotLayer.id);
  assert.notEqual(response.layerId, original.id);
  assert.equal(original.parent, current.target);
  assert.equal((await current.writer.place(request)).alreadyPlaced, true);
});

test('same display name inside a layer group cannot acknowledge a different task ID', async () => {
  const current = harness();
  const request = job({ name: 'background', taskId: 'first-background', groupName: 'AI group', mask: null });
  await current.writer.place(request);
  await assert.rejects(current.writer.place({ ...request, taskId: 'different-background' }), /另一个任务|覆盖/);
});

test('a failed pixel write rolls back and is not marked completed', async () => {
  const current = harness();
  const write = current.photoshop.imaging.putPixels;
  current.photoshop.imaging.putPixels = async () => { throw Error('pixels failed'); };
  await assert.rejects(current.writer.place(job()), /pixels failed/);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').at(-1), ['resume', 55, false]);
  assert.equal(current.target.layers[0], current.slotLayer);
  current.photoshop.imaging.putPixels = write;
  assert.equal((await current.writer.place(job())).placed, true);
});

test('closed or resized source is rejected before creating layers', async () => {
  const current = harness();
  await assert.rejects(current.writer.place(job({ documentId: 99 })), /原文档/);
  await assert.rejects(current.writer.place(job({ source: { width: 99, height: 80 } })), /尺寸/);
  assert.equal(current.calls.length, 0);
});

test('writer rejects a task bound to another helper session before touching a reused document ID', async () => {
  const current = harness();
  const writer = createWriter(current.photoshop, async (identity, offset, length) => current.assets[identity].slice(offset, offset + length), 'current-helper-session');
  await assert.rejects(writer.place(job({ source: { width: 100, height: 80, backgroundSessionId: 'previous-helper-session' } })), /会话|身份/);
  assert.equal(current.calls.length, 0);
});

test('writes to the reserved artboard layer only, and missing artboards are rejected', async () => {
  const current = harness();
  const artboard = current.layer('artboard one', current.target, true);
  await current.slotLayer.move(artboard, 'inside');
  current.calls.length = 0;
  await current.writer.place(job({ artboard: { id: artboard.id, name: artboard.name }, slot: { ...job().slot, parentId: artboard.id } }));
  assert.equal(artboard.layers.length, 1);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
  await assert.rejects(current.writer.place(job({ taskId: 'missing-board', artboard: { id: 888 } })), /画板/);
});

test('out-of-order completion is organised in the original layer order', async () => {
  const current = harness();
  const order = ['near', 'middle', 'background'];
  const group = current.layer('AI group', current.target, true);
  const slots = order.map(name => current.layer(name, group));
  for (const name of ['background', 'near', 'middle']) {
    const layer = slots[order.indexOf(name)];
    await current.writer.place(job({ name, taskId: name, mask: null, groupName: 'AI group', layerOrder: order,
      slot: { layerId: layer.id, name: layer.name, parentId: group.id, groupId: group.id, reservationId: 'layer-reservation' } }));
  }
  assert.deepEqual(group.layers.map(item => item.name), order);
  assert.equal(current.foreground.layers.length, 0);
});

test('invalid byte lengths are rejected before Photoshop edits', async () => {
  const current = harness();
  current.assets.pixels = new Uint8Array(4);
  await assert.rejects(current.writer.place(job()), /像素/);
  assert.equal(current.calls.length, 0);
});

test('switching documents while waiting for modal execution is not treated as a writer activation', async () => {
  const current = harness();
  const original = current.photoshop.core.executeAsModal;
  current.photoshop.core.executeAsModal = async operation => {
    current.photoshop.app.activeDocument = current.target;
    return original(operation);
  };
  await current.writer.place(job());
  assert.equal(current.target.layers.length, 1);
});

test('a late queued request expires before editing Photoshop', async () => {
  const current = harness();
  await assert.rejects(current.writer.place(job({ deadline: Date.now() - 1 })), /超时/);
  assert.equal(current.calls.length, 0);
});

test('large pixel buffers use stripes without replacing earlier stripes', async () => {
  const current = harness();
  current.target.width = 2048;
  current.target.height = 600;
  current.assets.pixels = new Uint8Array(2048 * 600 * 4);
  current.assets.mask = new Uint8Array(2048 * 600);
  for (let alpha = 3; alpha < current.assets.pixels.length; alpha += 4) current.assets.pixels[alpha] = 128;
  await current.writer.place(job({ source: { width: 2048, height: 600 }, target: { left: 0, top: 0, width: 2048, height: 600 } }));
  const writes = current.calls.filter(call => call[0] === 'pixels');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(call => [call[3].top, call[4]]), [[0, true], [512, false]]);
});

test('background return rejects mask creation and never calls the mask API', async () => {
  const current = harness();
  current.photoshop.imaging.putLayerMask = async () => { throw Error('mask creation can activate a document'); };
  await assert.rejects(current.writer.place(job({ mask: 'mask' })), /蒙版/);
  assert.equal(current.calls.length, 0);
  await current.writer.place(job());
});

test('opaque PNG pixels use RGB without changing colours or the prepared selection mask', async () => {
  const current = harness();
  current.assets.pixels = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
  current.photoshop.imaging.putPixels = async options => {
    assert.equal(options.imageData.components, 3);
    assert.deepEqual(Array.from(options.imageData.bytes), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  };
  assert.equal((await current.writer.place(job())).placed, true);
  assert.equal(current.calls.filter(call => call[0] === 'mask').length, 0);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
});

test('empty transparent stripes are not sent to Photoshop and the first visible stripe replaces pixels', async () => {
  const current = harness();
  current.target.width = 2048; current.target.height = 600;
  current.assets.pixels = new Uint8Array(2048 * 600 * 4);
  current.assets.pixels[2048 * 512 * 4 + 3] = 128;
  await current.writer.place(job({ source: { width: 2048, height: 600 }, target: { left: 0, top: 0, width: 2048, height: 600 } }));
  assert.deepEqual(current.calls.filter(call => call[0] === 'pixels').map(call => [call[3].top, call[4]]), [[512, true]]);
});

test('entirely invisible results fail before modal editing instead of claiming a blank success', async () => {
  const current = harness();
  current.assets.pixels.fill(0);
  await assert.rejects(current.writer.place(job()), error => error.phase === 'preparePixels' && /透明|可见/.test(error.message));
  assert.equal(current.calls.length, 0);
});

test('non-pixel and transparency-locked destination layers are diagnosed before putPixels', async () => {
  const current = harness();
  current.photoshop.constants.LayerKind = { NORMAL: 'normal', GROUP: 'group', SMARTOBJECT: 'smart' };
  current.slotLayer.kind = 'smart';
  await assert.rejects(current.writer.place(job()), /像素图层/);
  current.slotLayer.kind = 'normal'; current.slotLayer.transparentPixelsLocked = true;
  await assert.rejects(current.writer.place(job()), /透明.*锁定/);
  assert.equal(current.calls.length, 0);
});

test('native write errors include non-secret pixel and target diagnostics', async () => {
  const current = harness();
  current.photoshop.imaging.putPixels = async () => { throw Error('Photoshop Error. Code: -1'); };
  await assert.rejects(current.writer.place(job()), error => error.phase === 'putPixels' && error.pixelInfo.components === 3 &&
    error.pixelInfo.width === 2 && error.pixelInfo.layerId === 101 && error.pixelInfo.top === 7);
});

test('optional image disposal cannot roll back a successful pixel write or trigger a duplicate retry', async () => {
  const current = harness();
  current.photoshop.imaging.createImageDataFromBuffer = async (bytes, options) => ({ ...options, bytes,
    dispose() { throw Error('Photoshop Error. Code: -1'); } });
  const result = await current.writer.place(job());
  assert.equal(result.placed, true);
  assert.match(result.warnings.join(' '), /disposeImageData/);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [true]);
  assert.equal((await current.writer.place(job())).alreadyPlaced, true);
  assert.equal(current.calls.filter(call => call[0] === 'pixels').length, 1);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
});

test('disposal failure never overwrites the real putPixels error or its rollback', async () => {
  const current = harness();
  current.photoshop.imaging.createImageDataFromBuffer = async () => ({ dispose() { throw Error('cleanup failure'); } });
  current.photoshop.imaging.putPixels = async () => { throw Object.assign(Error('native write failure'), { number: -1 }); };
  await assert.rejects(current.writer.place(job()), error => error.phase === 'putPixels' &&
    error.number === -1 && error.message === 'native write failure');
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [false]);
});

test('a failed alpha mask rolls back the RGB write and permits later recovery', async () => {
  const current = harness();
  current.assets.pixels[3] = 128;
  const originalMask = current.photoshop.imaging.putLayerMask;
  current.photoshop.imaging.putLayerMask = async () => { throw Error('mask failed'); };
  await assert.rejects(current.writer.place(job()), error => error.phase === 'putAlphaMask' && /mask failed/.test(error.message));
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [false]);
  current.photoshop.imaging.putLayerMask = originalMask;
  assert.equal((await current.writer.place(job())).placed, true);
  assert.equal(current.photoshop.app.activeDocument, current.foreground);
});

test('opaque native failures do not invoke alpha compatibility or create a mask', async () => {
  const current = harness();
  for (let alpha = 3; alpha < current.assets.pixels.length; alpha += 4) current.assets.pixels[alpha] = 255;
  current.photoshop.imaging.putPixels = async () => { throw Object.assign(Error('opaque failed'), { number: -1 }); };
  await assert.rejects(current.writer.place(job()), /opaque failed/);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [false]);
  assert.equal(current.calls.filter(call => call[0] === 'mask').length, 0);
});

test('a post-commit history accessor failure cannot reject placement or allow duplicate writes', async () => {
  const current = harness();
  Object.defineProperty(current.target, 'activeHistoryState', { get() { throw Error('history unavailable'); } });
  assert.equal((await current.writer.place(job())).placed, true);
  assert.equal((await current.writer.place(job())).alreadyPlaced, true);
  assert.equal(current.calls.filter(call => call[0] === 'pixels').length, 1);
});

test('active-document guard failures are not mislabeled as native pixel errors', async () => {
  const current = harness();
  current.photoshop.imaging.putPixels = async () => { current.photoshop.app.activeDocument = current.target; };
  await assert.rejects(current.writer.place(job()), error => error.phase === 'verifyActiveDocument' && error.recoveryBlocked);
  assert.deepEqual(current.calls.filter(call => call[0] === 'resume').map(call => call[2]), [false]);
});

test('edge and full-canvas results preserve exact dimensions and origin without shrinking or switching', async () => {
  for (const bounds of [{ left: 2625, top: 0, width: 1471, height: 1422 }, { left: 0, top: 0, width: 4096, height: 1754 }]) {
    const current = harness();
    current.target.width = 4096; current.target.height = 1754;
    current.assets.pixels = new Uint8Array(bounds.width * bounds.height * 4);
    for (let alpha = 3; alpha < current.assets.pixels.length; alpha += 4) current.assets.pixels[alpha] = 128;
    const stripes = [];
    current.photoshop.imaging.putPixels = async options => {
      stripes.push({ bounds: options.targetBounds, width: options.imageData.width, height: options.imageData.height,
        replace: options.replace, documentId: options.documentID, layerId: options.layerID });
    };
    assert.equal((await current.writer.place(job({ source: { width: 4096, height: 1754 }, target: bounds }))).placed, true);
    let row = bounds.top;
    for (const [index, stripe] of stripes.entries()) {
      assert.deepEqual(stripe.bounds, { left: bounds.left, top: row });
      assert.equal(stripe.width, bounds.width);
      assert.equal(stripe.replace, index === 0);
      assert.equal(stripe.documentId, 11); assert.equal(stripe.layerId, 101);
      row += stripe.height;
    }
    assert.equal(row, bounds.top + bounds.height);
    assert.equal(current.photoshop.app.activeDocument, current.foreground);
  }
});

test('moving a reserved result group out of its submitted artboard prevents misplaced return', async () => {
  const current = harness();
  const artboard = current.layer('original artboard', current.target, true);
  const group = current.layer('AI results', current.target, true);
  const result = current.layer('background', group);
  await assert.rejects(current.writer.place(job({ artboard: { id: artboard.id }, groupName: group.name,
    slot: { layerId: result.id, parentId: group.id, groupId: group.id, name: result.name, reservationId: 'layer-reservation' } })), /画板|移动/);
  assert.equal(current.calls.length, 0);
});
