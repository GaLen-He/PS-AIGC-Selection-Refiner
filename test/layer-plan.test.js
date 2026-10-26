const assert = require("node:assert/strict");
const test = require("node:test");
const plan = require("../cep/AIGCSelectionRefiner/js/layer-plan.js");

test("parseLayerList trims, de-duplicates and caps layers", () => {
  const names = plan.parseLayerList(" 人物 \n\n人物\n道具\n背景");
  assert.deepEqual(names, ["人物", "道具", "背景"]);
  const many = plan.parseLayerList(Array.from({ length: 12 }, (_, i) => "层" + i).join("\n"));
  assert.equal(many.length, 8);
});

test("buildLayerJobs runs background first and uses green screen without transparency", () => {
  const jobs = plan.buildLayerJobs(["人物", "道具", "背景"], "写实风格", false);
  assert.deepEqual(jobs.map((job) => job.name), ["背景", "道具", "人物"]);
  assert.equal(jobs[0].kind, "background");
  assert.match(jobs[0].prompt, /删除画面中的人物、道具/);
  assert.equal(jobs[1].kind, "element");
  assert.match(jobs[1].prompt, /#00FF00/);
  assert.match(jobs[2].prompt, /写实风格/);
  const transparent = plan.buildLayerJobs(["人物", "背景"], "", true);
  assert.match(transparent[1].prompt, /透明/);
  assert.doesNotMatch(transparent[1].prompt, /#00FF00/);
  assert.throws(() => plan.buildLayerJobs([], "", false));
});

test("closestAspectRatio picks the nearest supported option", () => {
  assert.equal(plan.closestAspectRatio(["1:1", "16:9", "9:16"], 1920, 1080), "16:9");
  assert.equal(plan.closestAspectRatio(["1:1", "16:9", "9:16"], 800, 1500), "9:16");
});

test("chromaKey removes green background and keeps the subject", () => {
  const width = 6;
  const height = 6;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const inside = x >= 2 && x <= 3 && y >= 2 && y <= 3;
      data.set(inside ? [220, 30, 30, 255] : [0, 255, 0, 255], offset);
    }
  }
  plan.chromaKey(data, width, height, { force: true });
  assert.equal(data[3], 0);
  assert.equal(data[(2 * width + 2) * 4 + 3], 255);
  plan.markCanvasCorners(data, width, height);
  assert.ok(data[3] > 0);
});
test("dilateMask grows painted guide areas", () => {
  const mask = new Uint8Array(25);
  mask[12] = 255;
  const out = plan.dilateMask(mask, 5, 5, 1);
  assert.equal(out[6], 255);
  assert.equal(out[18], 255);
  assert.equal(out[0], 0);
  assert.equal(plan.hasMaskPixels(out), true);
  assert.equal(plan.hasMaskPixels(new Uint8Array(4)), false);
});

test("mask helpers clip alpha and fill outside with key color", () => {
  const data = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255]);
  plan.fillOutsideMask(data, new Uint8Array([255, 0]), [0, 255, 0]);
  assert.deepEqual(Array.from(data), [10, 20, 30, 255, 0, 255, 0, 255]);
  plan.applyMaskAlpha(data, new Uint8Array([255, 0]));
  assert.equal(data[3], 255);
  assert.equal(data[7], 0);
  assert.equal(plan.opaqueRatio(data), 0.5);
});

test("runPool runs jobs concurrently and keeps result order", async () => {
  let running = 0;
  let peak = 0;
  const results = await plan.runPool([30, 5, 15, 1], 3, async (delay, index) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, delay));
    running -= 1;
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3]);
  assert.equal(peak, 3);
});

test("guide annotations retain context and never change alpha", () => {
  const data = new Uint8ClampedArray([20, 40, 80, 255, 100, 120, 140, 128, 80, 90, 100, 255]);
  const original = new Uint8ClampedArray(data);
  const mask = new Uint8Array([0, 255, 0]);
  plan.annotateGuide(data, mask);
  assert.ok(data[0] > 0 && data[0] < original[0]);
  assert.ok(data[8] > 0 && data[8] < original[8]);
  assert.equal(data[3], 255);
  assert.equal(data[7], 128);
  assert.notEqual(data[4], original[4]);
  assert.deepEqual(Array.from(mask), [0, 255, 0]);
  assert.match(plan.guidedPrompt("角色"), /完整/);
  assert.doesNotMatch(plan.guidedPrompt("角色"), /只提取未被覆盖|请忽略/);
});

test('guide crop stores a source-space target with padding and supported aspect', () => {
  const mask = new Uint8Array(100 * 100);
  for (let row = 60; row < 80; row += 1) {
    for (let column = 20; column < 40; column += 1) mask[row * 100 + column] = 255;
  }
  const crop = plan.guideGeometry(mask, 100, 100, 1000, 800, ['2:1']);
  assert.deepEqual(crop, { left: 76, top: 448, right: 524, bottom: 672, width: 448, height: 224, ratio: '2:1' });
  assert.equal(plan.guideGeometry(new Uint8Array(4), 2, 2, 1000, 800, []), null);
});

test('aspect-mismatched output is contained without stretching and healing follows padding', () => {
  const fit = plan.containGeometry(1024, 1024, 1000, 500);
  assert.deepEqual(fit, { left: 250, top: 0, width: 500, height: 500 });
  assert.deepEqual(plan.mapHealRegions([{ left: 0, top: 0, right: 0.1, bottom: 0.1 }], fit, 1000, 500),
    [{ left: 0.25, top: 0, right: 0.3, bottom: 0.1 }]);
});

test('guide prompt makes painted region the target instead of a generic layer name', () => {
  const prompt = plan.guidedPrompt('近景', false, '保持画风');
  assert.match(prompt, /涂抹.*优先/);
  assert.match(prompt, /名称.*仅/);
  assert.match(prompt, /#00FF00/);
  assert.match(prompt, /不要居中|不居中/);
  assert.doesNotMatch(prompt, /头部、四肢/);
});

test("chroma key does not mistake blue sky or pale structures for key background", () => {
  const data = new Uint8ClampedArray(16 * 4);
  for (let index = 0; index < 16; index += 1) data.set([140, 180, 225, 255], index * 4);
  const original = new Uint8ClampedArray(data);
  assert.equal(plan.chromaKey(data, 4, 4, { force: true }).keyed, false);
  assert.deepEqual(data, original);
});

test("native transparency survives a model without the transparent option", () => {
  const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 255, 0, 255, 230, 230, 230, 120, 0, 0, 0, 0]);
  const original = new Uint8ClampedArray(data);
  assert.equal(plan.chromaKey(data, 2, 2, { force: true }).keyed, false);
  assert.deepEqual(data, original);
});
