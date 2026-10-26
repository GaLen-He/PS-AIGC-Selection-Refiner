const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageRoot = path.resolve(__dirname, '..');
const installer = path.join(packageRoot, 'install.ps1');
const signer = path.resolve(packageRoot, '../../tools/adobe-signing/ZXPSignCmd.exe');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function install(root, action = 'Install') {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${installer.replace(/'/g, "''")}' -LibraryOnly; ${action}-AigcPackage -DataRoot '${root.replace(/'/g, "''")}'`],
  { encoding: 'utf8', timeout: 30000 });
}

function runInstaller(source, root) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${source.replace(/'/g, "''")}' -LibraryOnly; Install-AigcPackage -DataRoot '${root.replace(/'/g, "''")}'`],
  { encoding: 'utf8', timeout: 30000 });
}

test('rebuilding a signed package does not reuse an existing archive destination', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'build-signed.ps1'), 'utf8');
  assert.match(source, /signedPackage\s*=\s*Join-Path\s+\$stage\s+'AIGCSelectionRefiner\.zxp'/);
  assert.match(source, /Move-Item\s+-LiteralPath\s+\$signedPackage\s+-Destination\s+\$destination\s+-Force/);
});

test('signed manifest matches the current source and installer version', () => {
  const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[IO.Compression.ZipFile]::OpenRead('${path.join(packageRoot, 'AIGCSelectionRefiner.zxp').replace(/'/g, "''")}'); try { $reader=New-Object IO.StreamReader($archive.GetEntry('CSXS/manifest.xml').Open()); try { $manifest=[xml]$reader.ReadToEnd(); Write-Output $manifest.ExtensionManifest.ExtensionBundleVersion } finally { $reader.Dispose() } } finally { $archive.Dispose() }`;
  const result = spawnSync(powershell, ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const integrity = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package-integrity.json'), 'utf8'));
  assert.equal(result.stdout.trim(), integrity.Version);
  const source = fs.readFileSync(path.join(packageRoot, 'AIGCSelectionRefiner/CSXS/manifest.xml'), 'utf8');
  assert.ok(source.includes(`ExtensionBundleVersion="${integrity.Version}"`));
});

test('installed CEP signature survives clean upgrade and credentials stay outside its folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-signature-'));
  const cep = path.join(root, 'Adobe/CEP/extensions/AIGCSelectionRefiner');
  fs.mkdirSync(path.join(cep, 'CSXS'), { recursive: true });
  fs.writeFileSync(path.join(cep, 'CSXS/manifest.xml'), '<old />');
  fs.writeFileSync(path.join(cep, 'personal-data.txt'), 'keep in backup');
  fs.writeFileSync(path.join(cep, 'bridge-token.json'), JSON.stringify({ token: 'd'.repeat(64) }));
  const result = install(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(cep, 'bridge-token.json')), false);
  assert.equal(fs.existsSync(path.join(cep, 'personal-data.txt')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'Adobe/AIGCSelectionRefiner/bridge-token.json'), 'utf8')).token, 'd'.repeat(64));
  const verified = spawnSync(signer, ['-verify', cep], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(install(root).status, 0);
  assert.equal(spawnSync(signer, ['-verify', cep]).status, 0);
  const restored = install(root, 'Restore');
  assert.equal(restored.status, 0, restored.stderr || restored.stdout);
  assert.equal(fs.readFileSync(path.join(cep, 'personal-data.txt'), 'utf8'), 'keep in backup');
  assert.equal(fs.readFileSync(path.join(cep, 'CSXS/manifest.xml'), 'utf8'), '<old />');
  assert.equal(fs.existsSync(path.join(cep, 'META-INF/signatures.xml')), false);
});

test('signed package is checked before the existing installation is moved', () => {
  const source = fs.readFileSync(installer, 'utf8');
  const section = source.slice(source.indexOf('function Install-AigcPackage'), source.indexOf('function Disable-AigcPackage'));
  assert.ok(section.indexOf('Expand-AigcSignedCep') >= 0);
  assert.ok(section.indexOf('Expand-AigcSignedCep') < section.indexOf('Move-AigcCepAside'));
  assert.doesNotMatch(source, /PlayerDebugMode|Set-ExecutionPolicy|Import-Certificate/);
});

test('runtime reads credentials outside the signed CEP payload', () => {
  const source = fs.readFileSync(path.join(packageRoot, 'AIGCSelectionRefiner/js/main.js'), 'utf8');
  const section = source.slice(source.indexOf('function getBackgroundBridge'), source.indexOf('function getBackgroundReturn'));
  assert.match(section, /process\.env\.APPDATA/);
  assert.doesNotMatch(section, /path\.join\(extensionPath,\s*"bridge-token\.json"\)/);
});

test('tampered signed archive fails before touching an old installation or registry', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-tamper-'));
  const copy = path.join(temporary, 'package');
  fs.cpSync(packageRoot, copy, { recursive: true });
  fs.appendFileSync(path.join(copy, 'AIGCSelectionRefiner.zxp'), 'modified');
  const root = path.join(temporary, 'appdata');
  const cep = path.join(root, 'Adobe/CEP/extensions/AIGCSelectionRefiner');
  const registry = path.join(root, 'Adobe/UXP/PluginsInfo/v1/PS.json');
  fs.mkdirSync(path.join(cep, 'CSXS'), { recursive: true });
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(path.join(cep, 'CSXS/manifest.xml'), '<old />');
  const original = JSON.stringify({ plugins: [{ pluginId: 'another-plugin', status: 'enabled' }] });
  fs.writeFileSync(registry, original);
  const result = runInstaller(path.join(copy, 'install.ps1'), root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrity check failed/);
  assert.equal(fs.readFileSync(path.join(cep, 'CSXS/manifest.xml'), 'utf8'), '<old />');
  assert.equal(fs.readFileSync(registry, 'utf8'), original);
});

test('an error committing CEP rolls back old CEP and helper registration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-commit-fail-'));
  const cep = path.join(root, 'Adobe/CEP/extensions/AIGCSelectionRefiner');
  const registry = path.join(root, 'Adobe/UXP/PluginsInfo/v1/PS.json');
  fs.mkdirSync(path.join(cep, 'CSXS'), { recursive: true });
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(path.join(cep, 'CSXS/manifest.xml'), '<old />');
  const original = { plugins: [{ pluginId: 'aigcreturn', versionString: '0.5.19', status: 'enabled' }] };
  fs.writeFileSync(registry, JSON.stringify(original));
  const command = `. '${installer.replace(/'/g, "''")}' -LibraryOnly; function Move-AigcCepAside { throw 'Simulated commit failure' }; Install-AigcPackage -DataRoot '${root.replace(/'/g, "''")}'`;
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Simulated commit failure/);
  assert.equal(fs.readFileSync(path.join(cep, 'CSXS/manifest.xml'), 'utf8'), '<old />');
  assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')), original);
});
