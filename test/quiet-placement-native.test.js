const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helper = path.join(__dirname, '../cep/AIGCSelectionRefiner/host/quiet-placement.exe');

test('bundled native helper restores a disposable window without modifying Photoshop', { skip: process.platform !== 'win32' }, () => {
  const result = childProcess.spawnSync(helper, ['--self-test'], { windowsHide: true, encoding: 'utf8', timeout: 6000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /redraw suppression and restoration: PASS/);
});

test('bundled native helper respects cancellation before touching Photoshop redraw', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-aigc-native-test-'));
  try {
    fs.writeFileSync(path.join(directory, 'release'), '1');
    const result = childProcess.spawnSync(helper, ['-OwnerPid', String(process.pid), '-SessionDirectory', directory], { windowsHide: true, encoding: 'utf8', timeout: 6000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const messages = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(messages[0].frozen, false);
    assert.equal(messages[0].reason, 'cancelled');
    assert.equal(messages[1].restored, true);
  } finally {
    fs.unlinkSync(path.join(directory, 'release'));
    fs.rmdirSync(directory);
  }
});
