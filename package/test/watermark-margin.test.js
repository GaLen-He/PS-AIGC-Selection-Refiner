const test = require('node:test');
const assert = require('node:assert');
const frame = require('../AIGCSelectionRefiner/js/selection-frame.js');
const options = { options: ['1:1', '4:3', '3:4', '16:9', '9:16'].map(value => ({ value })) };

test('margin pads every side and crop returns only the original content', () => {
  const resolved = frame.resolve({ AspectRatio: frame.ORIGINAL }, options, 1000, 1000, 0.08);
  const f = resolved.frame;
  assert.equal(resolved.parameters.AspectRatio, '1:1');
  assert.ok(f.left >= 79 && f.top >= 79);
  const crop = frame.crop(f, 2048, 2048);
  const scale = 2048 / f.width;
  assert.ok(Math.abs(crop.left - f.left * scale) < 1e-6);
  assert.ok(Math.abs(crop.width - 1000 * scale) < 1);
  assert.ok(crop.left + crop.width <= 2048 - 140);
});

test('margin also applies to a fixed user ratio', () => {
  const resolved = frame.resolve({ AspectRatio: '16:9' }, options, 1600, 900, 0.08);
  assert.equal(resolved.parameters.AspectRatio, '16:9');
  assert.ok(resolved.frame.left > 0 && resolved.frame.top > 0);
  assert.ok(Math.abs(resolved.frame.width / resolved.frame.height - 16 / 9) < 0.01);
});

test('no margin keeps the previous exact-ratio behaviour', () => {
  assert.equal(frame.resolve({ AspectRatio: frame.ORIGINAL }, options, 1000, 1000, 0).frame, null);
  assert.equal(frame.resolve({ AspectRatio: '1:1' }, options, 1000, 1000).frame, null);
});

test('single-axis margin pads only top and bottom with a native original ratio', () => {
  const native = { options: [{ value: 'auto' }, { value: '1:1' }] };
  const f = frame.resolve({ AspectRatio: frame.ORIGINAL }, native, 1000, 600, { x: 0, y: 0.08 }).frame;
  assert.equal(f.left, 0);
  assert.ok(f.top >= 47 && f.top <= 49);
  assert.equal(f.width, 1000);
  const crop = frame.crop(f, f.width * 2, f.height * 2);
  assert.ok(Math.abs(crop.height - 1200) < 1);
});

test('padding crop snaps inward so no padding pixel is kept', () => {
  const snapped = frame.snapInside({ left: 10.4, top: 80.6, width: 100.2, height: 50.5 });
  assert.deepEqual(snapped, { left: 11, top: 81, width: 99, height: 50 });
});

test('single-axis margin pads only left and right with a native original ratio', () => {
  const native = { options: [{ value: 'auto' }] };
  const f = frame.resolve({ AspectRatio: frame.ORIGINAL }, native, 1000, 600, { x: 0.08, y: 0 }).frame;
  assert.equal(f.top, 0);
  assert.ok(f.left >= 79 && f.left <= 81);
});
