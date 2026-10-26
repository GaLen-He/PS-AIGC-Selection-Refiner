const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const installer = path.join(__dirname, '../install.ps1');
const helperVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../uxp-helper/manifest.json'), 'utf8')).version;
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function run(root, action) {
  const command = `. '${installer.replace(/'/g, "''")}' -LibraryOnly; ${action}-AigcPackage -DataRoot '${root.replace(/'/g, "''")}'`;
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-offline-installer-'));
  const cep = path.join(root, 'Adobe/CEP/extensions/AIGCSelectionRefiner');
  const registry = path.join(root, 'Adobe/UXP/PluginsInfo/v1/PS.json');
  fs.mkdirSync(path.join(cep, 'CSXS'), { recursive: true });
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(path.join(cep, 'CSXS/manifest.xml'), '<old-version />');
  fs.writeFileSync(path.join(cep, 'personal-data.txt'), 'keep local');
  fs.writeFileSync(registry, JSON.stringify({ extraSetting: 7, plugins: [{ pluginId: 'third-party', status: 'enabled', name: 'Existing' }] }));
  return { root, cep, registry };
}

test('installer backs up CEP, merges only its own helper and generates local matching tokens', () => {
  const current = fixture();
  run(current.root, 'Install');
  const configuration = JSON.parse(fs.readFileSync(current.registry, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(configuration.extraSetting, 7);
  assert.equal(configuration.plugins.find(item => item.pluginId === 'third-party').status, 'enabled');
  assert.equal(configuration.plugins.filter(item => item.pluginId === 'aigcreturn').length, 1);
  const helper = path.join(current.root, 'Adobe/UXP/Plugins/External/aigcreturn_' + helperVersion);
  const token = JSON.parse(fs.readFileSync(path.join(current.root, 'Adobe/AIGCSelectionRefiner/bridge-token.json'), 'utf8').replace(/^\uFEFF/, '')).token;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(helper, 'bridge-token.json'), 'utf8').replace(/^\uFEFF/, '')).token, token);
  assert.equal(fs.existsSync(path.join(current.cep, 'host/quiet-placement.exe')), false);
  const state = JSON.parse(fs.readFileSync(path.join(current.root, 'Adobe/AIGCSelectionRefiner/install-state.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(state.BackupCep, 'personal-data.txt'), 'utf8'), 'keep local');
  run(current.root, 'Install');
  const second = JSON.parse(fs.readFileSync(current.registry, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(second.plugins.filter(item => item.pluginId === 'aigcreturn').length, 1);
  run(current.root, 'Restore');
  assert.equal(fs.readFileSync(path.join(current.cep, 'CSXS/manifest.xml'), 'utf8'), '<old-version />');
});

test('uninstall removes AIGC files and preserves third-party plugins', () => {
  const current = fixture();
  run(current.root, 'Install');
  run(current.root, 'Disable');
  const configuration = JSON.parse(fs.readFileSync(current.registry, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(configuration.extraSetting, 7);
  assert.equal(configuration.plugins.some(item => item.pluginId === 'aigcreturn'), false);
  assert.equal(configuration.plugins.find(item => item.pluginId === 'third-party').status, 'enabled');
  assert.equal(fs.existsSync(current.cep), false);
  assert.equal(fs.existsSync(path.join(current.root, 'Adobe/AIGCSelectionRefiner')), false);
  assert.equal(fs.readdirSync(path.join(current.root, 'Adobe/UXP/Plugins/External')).some(name => name.startsWith('aigcreturn_')), false);
});

test('invalid UXP configuration is rejected before replacing any installed CEP files', () => {
  const current = fixture();
  fs.writeFileSync(current.registry, '{broken json');
  assert.throws(() => run(current.root, 'Install'));
  assert.equal(fs.readFileSync(path.join(current.cep, 'CSXS/manifest.xml'), 'utf8'), '<old-version />');
  assert.equal(fs.readFileSync(current.registry, 'utf8'), '{broken json');
});

test('restore recovers a preexisting same-version helper payload and its original local token', () => {
  const current = fixture();
  const helper = path.join(current.root, 'Adobe/UXP/Plugins/External/aigcreturn_' + helperVersion);
  fs.mkdirSync(helper, { recursive: true });
  fs.writeFileSync(path.join(helper, 'index.js'), 'old helper source');
  fs.writeFileSync(path.join(helper, 'bridge-token.json'), JSON.stringify({ token: 'a'.repeat(64) }));
  const configuration = JSON.parse(fs.readFileSync(current.registry, 'utf8'));
  const originalEntry = { pluginId: 'aigcreturn', status: 'enabled', versionString: helperVersion,
    path: '$localPlugins\\External\\aigcreturn_' + helperVersion };
  configuration.plugins.push(originalEntry);
  fs.writeFileSync(current.registry, JSON.stringify(configuration));
  run(current.root, 'Install');
  assert.notEqual(fs.readFileSync(path.join(helper, 'index.js'), 'utf8'), 'old helper source');
  run(current.root, 'Install');
  run(current.root, 'Restore');
  assert.equal(fs.readFileSync(path.join(helper, 'index.js'), 'utf8'), 'old helper source');
  assert.equal(JSON.parse(fs.readFileSync(path.join(helper, 'bridge-token.json'), 'utf8')).token, 'a'.repeat(64));
  const restored = JSON.parse(fs.readFileSync(current.registry, 'utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(restored.plugins.find(item => item.pluginId === 'aigcreturn'), originalEntry);
  assert.equal(restored.plugins.find(item => item.pluginId === 'third-party').status, 'enabled');
});
