const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('visible panel version matches the installed CEP manifest', () => {
  const payload = path.join(__dirname, '../AIGCSelectionRefiner');
  const manifest = fs.readFileSync(path.join(payload, 'CSXS/manifest.xml'), 'utf8');
  const html = fs.readFileSync(path.join(payload, 'index.html'), 'utf8');
  const manifestVersion = manifest.match(/ExtensionBundleVersion="([^"]+)"/);
  const visibleVersion = html.match(/<p>(\d+\.\d+\.\d+)<\/p>/);
  assert.ok(manifestVersion, 'CEP version is required');
  assert.ok(visibleVersion, 'Visible version is required');
  assert.equal(visibleVersion[1], manifestVersion[1]);
});

test('panel title, heading and Photoshop menu use the requested name', () => {
  const payload = path.join(__dirname, '../AIGCSelectionRefiner');
  const manifest = fs.readFileSync(path.join(payload, 'CSXS/manifest.xml'), 'utf8');
  const html = fs.readFileSync(path.join(payload, 'index.html'), 'utf8');
  assert.match(html, /<title>AIGC选区提交\/整图分层<\/title>/);
  assert.match(html, /<h1>AIGC选区提交\/整图分层<\/h1>/);
  assert.match(manifest, /<Menu>AIGC选区提交\/整图分层<\/Menu>/);
  assert.match(manifest, /ExtensionBundleName="AIGC选区提交\/整图分层"/);
});
