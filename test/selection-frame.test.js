const assert = require('node:assert/strict');
const test = require('node:test');
const frame = require('../cep/AIGCSelectionRefiner/js/selection-frame');

test('original selection ratio is local-only and pads to the nearest platform ratio', () => {
  const resolved = frame.resolve({ AspectRatio: frame.ORIGINAL, Quality: 'high' }, { options: ['1:1', '16:9', '21:9'] }, 1000, 900);
  assert.equal(resolved.parameters.AspectRatio, '1:1');
  assert.equal(resolved.parameters.Quality, 'high');
  assert.deepEqual(resolved.frame, { width: 1000, height: 1000, left: 0, top: 50, contentWidth: 1000, contentHeight: 900 });
  assert.doesNotMatch(JSON.stringify(resolved.parameters), /__selection_original__/);
});

test('native original and fixed ratios are respected', () => {
  assert.deepEqual(frame.resolve({ AspectRatio: frame.ORIGINAL }, { options: ['16:9', { value: 'auto' }] }, 100, 80), { parameters: { AspectRatio: 'auto' }, frame: null });
  assert.deepEqual(frame.resolve({ AspectRatio: '4:3' }, { options: ['1:1'] }, 100, 80), { parameters: { AspectRatio: '4:3' }, frame: null });
  assert.throws(() => frame.resolve({ AspectRatio: frame.ORIGINAL }, { options: ['wide'] }, 100, 80), /未提供可适配/);
});

test('returned frame is cropped at its actual resolution and rejects mismatched frames', () => {
  const value = frame.resolve({ AspectRatio: frame.ORIGINAL }, { options: ['2:1'] }, 100, 100).frame;
  assert.deepEqual(frame.crop(value, 400, 200), { left: 100, top: 0, width: 200, height: 200 });
  assert.throws(() => frame.crop(value, 300, 300), /比例与提交比例不符/);
});
