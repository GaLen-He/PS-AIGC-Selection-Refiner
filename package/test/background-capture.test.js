const assert = require('node:assert/strict');
const test = require('node:test');
const { createCapture } = require('../uxp-helper/capture.js');

function harness() {
  const calls = [];
  const target = { id: 11, width: 100, height: 80, historyStates: [{}, {}], activeHistoryState: { name: 'selection' } };
  const args = { documentId: 11, source: { width: 100, height: 80 }, historyStamp: '2:selection',
    selection: { left: -3, top: 7, right: -1, bottom: 9, width: 2, height: 2 }, deadline: Date.now() + 10000 };
  const image = { components: 1, componentSize: 8, width: 2, height: 2,
    getData: async () => new Uint8Array([0, 128, 255, 255]), dispose: () => calls.push('dispose') };
  const photoshop = { app: { documents: [target], activeDocument: target },
    core: { executeAsModal: async (operation, options) => { calls.push(options.commandName); return operation({ isCancelled: false }); } },
    imaging: { getSelection: async options => { calls.push(options); return { imageData: image, sourceBounds: args.selection }; } } };
  return { calls, target, args, image, photoshop, capture: createCapture(photoshop) };
}

test('captures a grayscale selection with explicit document ID inside a short modal', async () => {
  const current = harness();
  const result = await current.capture(current.args);
  assert.deepEqual(Array.from(result.data), [0, 128, 255, 255]);
  assert.equal(current.calls[0], 'AIGC 读取原选区');
  assert.equal(current.calls[1].documentID, 11);
  assert.equal(current.calls.at(-1), 'dispose');
});

test('changing the active document while waiting for modal prevents capture', async () => {
  const current = harness();
  current.photoshop.core.executeAsModal = async operation => {
    current.photoshop.app.activeDocument = { id: 99 };
    return operation({});
  };
  await assert.rejects(current.capture(current.args), /文档/);
  assert.equal(current.calls.length, 0);
});

test('expired, resized or edited selection context is rejected before reading pixels', async () => {
  const current = harness();
  await assert.rejects(current.capture({ ...current.args, deadline: 1 }), /超时/);
  await assert.rejects(current.capture({ ...current.args, historyStamp: '1:old' }), /改变/);
  await assert.rejects(current.capture({ ...current.args, source: { width: 99, height: 80 } }), /改变/);
  assert.ok(current.calls.every(call => typeof call === 'string'));
});

test('invalid mask dimensions or failed pixel read release the UXP image', async () => {
  const current = harness();
  current.image.width = 3;
  await assert.rejects(current.capture(current.args), /尺寸/);
  assert.equal(current.calls.at(-1), 'dispose');
  current.image.width = 2;
  current.image.getData = async () => { throw Error('read failure'); };
  await assert.rejects(current.capture(current.args), /read failure/);
  assert.equal(current.calls.at(-1), 'dispose');
});

test('a context changed during mask read cannot be paired with the next export', async () => {
  const current = harness();
  current.image.getData = async () => { current.target.activeHistoryState.name = 'changed'; return new Uint8Array(4); };
  await assert.rejects(current.capture(current.args), /改变/);
  assert.equal(current.calls.at(-1), 'dispose');
});
