const assert = require("node:assert/strict");
const test = require("node:test");

function cleanup() {
  return require("../cep/AIGCSelectionRefiner/js/result-cleanup.js");
}

function fixture(transparent) {
  const width = 800;
  const height = 400;
  const data = new Uint8ClampedArray(width * height * 4);
  if (!transparent) {
    for (let index = 0; index < width * height; index += 1) data.set([80, 125, 180, 255], index * 4);
  }
  const origins = [[8, 12], [742, 12], [8, 376], [742, 376]];
  for (const [left, top] of origins) {
    for (let glyph = 0; glyph < 5; glyph += 1) {
      for (let row = 0; row < 10; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (column === 0 || column === 4 || row === 0 || row === 5) {
            data.set([210, 218, 225, 255], ((top + row) * width + left + glyph * 8 + column) * 4);
          }
        }
      }
    }
  }
  return { data, width, height, origins };
}

function singleCornerFixture(glyphCount, background, ink) {
  const width = 800;
  const height = 400;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set(background, index * 4);
  for (let glyph = 0; glyph < glyphCount; glyph += 1) {
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (column === 0 || column === 4 || row === 0 || row === 5) {
          data.set(ink, ((12 + row) * width + 8 + glyph * 8 + column) * 4);
        }
      }
    }
  }
  return { data, width, height };
}

test("detects a single confident corner string without needing matching corners", () => {
  const image = singleCornerFixture(6, [80, 125, 180, 255], [210, 218, 225, 255]);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  assert.equal(regions.length, 1);
  assert.ok(regions[0].left <= 8 && regions[0].right >= 53);
});

test("detects longer corner strings without expanding to a large destructive rectangle", () => {
  const image = singleCornerFixture(16, [80, 125, 180, 255], [210, 218, 225, 255]);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  assert.equal(regions.length, 1);
  assert.ok(regions[0].right >= 133);
  assert.ok((regions[0].right - regions[0].left) / image.width <= 0.2);
});

test("dark neutral corner lettering is detected on a light image", () => {
  const image = singleCornerFixture(6, [230, 230, 230, 255], [65, 65, 65, 255]);
  assert.equal(cleanup().detectCornerText(image.data, image.width, image.height).length, 1);
});

test("an isolated short set of corner details is not enough to trigger cleanup", () => {
  const image = singleCornerFixture(4, [80, 125, 180, 255], [210, 218, 225, 255]);
  assert.deepEqual(cleanup().detectCornerText(image.data, image.width, image.height), []);
});

test("local repair removes confirmed strokes over pixels before Photoshop healing", () => {
  const image = fixture(false);
  const original = new Uint8ClampedArray(image.data);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height, regions, { repair: true });
  assert.equal(result.repaired, 4);
  assert.equal(result.healRegions.length, 4);
  for (const [left, top] of image.origins) {
    const offset = (top * image.width + left) * 4;
    assert.deepEqual(Array.from(image.data.slice(offset, offset + 4)), [80, 125, 180, 255]);
  }
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    assert.equal(image.data[pixel * 4 + 3], original[pixel * 4 + 3]);
    const column = pixel % image.width;
    const row = Math.floor(pixel / image.width);
    if (!regions.some(region => column >= region.left && column < region.right && row >= region.top && row < region.bottom)) {
      assert.deepEqual(image.data.slice(pixel * 4, pixel * 4 + 4), original.slice(pixel * 4, pixel * 4 + 4));
    }
  }
});

test("local repair does not paint through transparency or infer missing text masks", () => {
  const image = singleCornerFixture(0, [0, 0, 0, 0], [210, 218, 225, 255]);
  const textPixel = 12 * image.width + 8;
  image.data.set([220, 40, 20, 150], textPixel * 4);
  const original = new Uint8ClampedArray(image.data);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height,
    [{ left: 6, top: 10, right: 50, bottom: 30, textPixels: [textPixel] }], { repair: true });
  assert.equal(result.repaired, 0);
  assert.deepEqual(image.data, original);
  const opaque = fixture(false);
  const opaqueOriginal = new Uint8ClampedArray(opaque.data);
  cleanup().prepareCleanup(opaque.data, opaque.width, opaque.height,
    [{ left: 6, top: 10, right: 50, bottom: 30 }], { repair: true });
  assert.deepEqual(opaque.data, opaqueOriginal);
});

test("detects text-like runs in four corners, not arbitrary rectangles", () => {
  const image = fixture(false);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  assert.equal(regions.length, 4);
  for (const [left, top] of image.origins) {
    assert.ok(regions.some((region) => region.left <= left && region.top <= top && region.right >= left + 37 && region.bottom >= top + 10));
  }
});

test("isolated corner lettering is deleted without changing central subject", () => {
  const image = fixture(true);
  const middle = (200 * image.width + 400) * 4;
  image.data.set([220, 40, 20, 255], middle);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height, regions);
  assert.equal(result.deleted, 4);
  assert.equal(result.healRegions.length, 0);
  assert.deepEqual(Array.from(image.data.slice(middle, middle + 4)), [220, 40, 20, 255]);
  for (const [left, top] of image.origins) assert.equal(image.data[(top * image.width + left) * 4 + 3], 0);
});

test("lettering over real pixels requires healing, not transparency", () => {
  const image = fixture(false);
  const original = new Uint8ClampedArray(image.data);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height, regions);
  assert.equal(result.deleted, 0);
  assert.equal(result.healRegions.length, 4);
  assert.deepEqual(image.data, original);
});

test("transparent cleanup preserves non-letter white details inside the text rectangle", () => {
  const image = fixture(true);
  const offset = ((image.origins[0][1] + 8) * image.width + image.origins[0][0] + 6) * 4;
  image.data.set([240, 240, 240, 255], offset);
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height, regions);
  assert.equal(image.data[offset + 3], 255);
  assert.equal(result.skipped, 1);
});

test("no cleanup on unmarked image or lone corner detail", () => {
  const image = fixture(false);
  for (let index = 0; index < image.width * image.height; index += 1) image.data.set([120, 150, 180, 255], index * 4);
  assert.deepEqual(cleanup().detectCornerText(image.data, image.width, image.height), []);
  for (let row = 10; row < 26; row += 1) {
    for (let column = 8; column < 50; column += 1) image.data.set([240, 240, 240, 255], (row * image.width + column) * 4);
  }
  assert.deepEqual(cleanup().detectCornerText(image.data, image.width, image.height), []);
});

test("healing coordinates are normalized and clamped", () => {
  const image = fixture(false);
  const result = cleanup().prepareCleanup(image.data, image.width, image.height, [{ left: -2, top: 12, right: 48, bottom: 25 }]);
  assert.deepEqual(result.healRegions, [{ left: 0, top: 0.03, right: 0.06, bottom: 0.0625 }]);
});

test("includes faint fragmented edge glyphs next to a confirmed text run", () => {
  const image = fixture(false);
  for (const [left, top] of image.origins) {
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        const fragment = row >= 3 && row <= 5 && (column === 0 || row === 5);
        image.data.set(fragment ? [210, 218, 225, 255] : [80, 125, 180, 255], ((top + row) * image.width + left + column) * 4);
      }
    }
  }
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  assert.equal(regions.length, 4);
  for (const [left, top] of image.origins) {
    assert.ok(regions.some((region) => region.left <= left && region.top <= top && region.right >= left + 37));
  }
});

test("allows one faint edge glyph around a confirmed run without a large corner crop", () => {
  const image = fixture(false);
  for (const [left, top] of image.origins) {
    for (let row = 0; row < 10; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        const offset = ((top + row) * image.width + left + column) * 4;
        if (image.data[offset] === 210) image.data.set([100, 132, 175, 255], offset);
      }
    }
  }
  const regions = cleanup().detectCornerText(image.data, image.width, image.height);
  assert.equal(regions.length, 4);
  for (const [left, top] of image.origins) {
    assert.ok(regions.some((region) => region.left <= left && region.top <= top && region.right >= left + 37 && region.right - region.left < 60));
  }
});
