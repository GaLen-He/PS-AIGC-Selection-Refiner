const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../AIGCSelectionRefiner/js/studio-catalog.js');

test('skips i18n bundles and picks the studio config script', () => {
  const html = '<script src="/aigc/assets/model-icons.js"></script>'
    + '<script src="/aigc/assets/aigc-i18n-en.js?v=1"></script>'
    + '<script src="/aigc/assets/aigc-i18n.js?v=1"></script>'
    + '<script src="/aigc/assets/aigc.js?v=studio&amp;theme=x"></script>'
    + '<script src="/aigc/assets/aigc-canvas-media.js?v=1"></script>';
  assert.strictEqual(catalog.findStudioScript('https://example.test/aigc', html), 'https://example.test/aigc/assets/aigc.js?v=studio&theme=x');
});

test('accepts hashed studio bundle names', () => {
  const html = '<script src="/aigc/assets/aigc-i18n.js"></script><script src="/aigc/assets/aigc.3fa9c21b.js"></script>';
  assert.strictEqual(catalog.findStudioScript('https://example.test/aigc', html), 'https://example.test/aigc/assets/aigc.3fa9c21b.js');
});
