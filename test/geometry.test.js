const assert = require("node:assert/strict");
const test = require("node:test");

const { calculateTranslation, normalizeBounds } = require("../src/geometry");

test("normalizeBounds converts Photoshop unit values to integer geometry", () => {
  const bounds = normalizeBounds({
    left: { _value: 12.2 },
    top: { _value: 5.8 },
    right: { _value: 112.2 },
    bottom: { _value: 55.8 }
  });

  assert.deepEqual(bounds, {
    left: 12,
    top: 6,
    right: 112,
    bottom: 56,
    width: 100,
    height: 50
  });
});

test("normalizeBounds rejects missing or empty selections", () => {
  assert.throws(() => normalizeBounds(null), /No active selection/);
  assert.throws(() => normalizeBounds({ left: 10, top: 10, right: 10, bottom: 20 }), /No active selection/);
});

test("calculateTranslation aligns returned layer top-left with selection top-left", () => {
  assert.deepEqual(
    calculateTranslation(
      { left: 40, top: 80, right: 240, bottom: 180 },
      { left: 100, top: 120, right: 300, bottom: 220 }
    ),
    { x: 60, y: 40 }
  );
});
