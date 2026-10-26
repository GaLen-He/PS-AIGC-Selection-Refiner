param(
  [ValidateSet('Install', 'Disable', 'Restore')][string]$Mode = 'Install',
  [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$script:PackageRoot = $PSScriptRoot
$script:AigcVersion = '0.5.30'
$script:CepPayload = @(
  'index.html', 'CSXS\manifest.xml', 'css\styles.css', 'host\AIGCSelectionRefiner.jsx',
  'js\CSInterface.js', 'js\api-client.js', 'js\layer-plan.js', 'js\main.js',
  'js\result-cleanup.js', 'js\selection-frame.js', 'js\studio-catalog.js',
  'js\background-bridge.js', 'js\background-return.js', 'js\recovery-state.js', 'js\task-progress.js'
)
$script:HelperPayload = @('manifest.json', 'index.js', 'writer.js', 'capture.js', 'reservation.js', 'snapshot-reader.js')

function Get-AigcPaths([string]$DataRoot) {
  if (-not $DataRoot) { $DataRoot = $env:APPDATA }
  if (-not $DataRoot) { throw 'APPDATA is unavailable.' }
  $root = [IO.Path]::GetFullPath($DataRoot)
  return @{
    Root = $root
    Cep = Join-Path $root 'Adobe\CEP\extensions\AIGCSelectionRefiner'
    Helper = Join-Path $root ('Adobe\UXP\Plugins\External\aigcreturn_' + $script:AigcVersion)
    Registry = Join-Path $root 'Adobe\UXP\PluginsInfo\v1\PS.json'
    State = Join-Path $root 'Adobe\AIGCSelectionRefiner\install-state.json'
    Token = Join-Path $root 'Adobe\AIGCSelectionRefiner\bridge-token.json'
    Backups = Join-Path $root 'Adobe\AIGCSelectionRefiner\install-backups'
  }
}

function Assert-AigcChild([string]$Path, [string]$Root) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation path.' }
}

function Read-AigcJson([string]$Path) {
  return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}

function Write-AigcJson([string]$Path, $Value, [string]$Root) {
  Assert-AigcChild $Path $Root
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
  $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 32), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-AigcRegistry($Paths) {
  $configuration = [pscustomobject]@{ plugins = @() }
  if (Test-Path -LiteralPath $Paths.Registry -PathType Leaf) { $configuration = Read-AigcJson $Paths.Registry }
  if (-not ($configuration -is [pscustomobject])) { throw 'Invalid PS.json. The existing configuration was not modified.' }
  if ($null -ne $configuration.plugins -and -not ($configuration.plugins -is [array])) { throw 'Invalid plugins list in PS.json.' }
  return $configuration
}

function Set-AigcPlugins($Configuration, [array]$Plugins) {
  $Configuration | Add-Member -MemberType NoteProperty -Name plugins -Value $Plugins -Force
}

function Copy-AigcPayload([string]$Source, [string]$Destination, [array]$Files, [string]$Root) {
  Assert-AigcChild $Destination $Root
  foreach ($relative in $Files) {
    $target = Join-Path $Destination $relative
    Assert-AigcChild $target $Destination
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $Source $relative) -Destination $target -Force
  }
}

function Get-AigcHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '') }
  finally { $hash.Dispose(); $stream.Dispose() }
}

function Test-AigcSignature([string]$Path) {
  $verifier = Join-Path $script:PackageRoot 'tools\ZXPSignCmd.exe'
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'Adobe signature verifier is missing. Extract the entire ZIP.' }
  $expected = (Read-AigcJson (Join-Path $script:PackageRoot 'package-integrity.json')).VerifierSHA256
  if ((Get-AigcHash $verifier) -ne $expected) { throw 'Adobe verifier integrity check failed.' }
  $output = & $verifier -verify $Path 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('CEP signature verification failed: ' + ($output -join ' ')) }
}

function Expand-AigcSignedCep($Paths) {
  $signedPackage = Join-Path $script:PackageRoot 'AIGCSelectionRefiner.zxp'
  if (-not (Test-Path -LiteralPath $signedPackage -PathType Leaf)) { throw 'Signed CEP package is missing. Extract the entire ZIP.' }
  $expected = (Read-AigcJson (Join-Path $script:PackageRoot 'package-integrity.json')).PackageSHA256
  if ((Get-AigcHash $signedPackage) -ne $expected) { throw 'Signed package integrity check failed. Download the complete package again.' }
  Test-AigcSignature $signedPackage
  $stage = Join-Path $Paths.Backups ('staging-' + [guid]::NewGuid().ToString('N'))
  Assert-AigcChild $stage $Paths.Backups
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($signedPackage)
  $allowed = @($script:CepPayload | ForEach-Object { $_.Replace('\', '/') }) + @('META-INF/signatures.xml', 'mimetype')
  try {
    $seen = @{}
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith('/')) { continue }
      if ($allowed -cnotcontains $entry.FullName -or $seen.ContainsKey($entry.FullName) -or $entry.Length -gt 16777216) { throw 'Unexpected file in signed CEP package.' }
      $seen[$entry.FullName] = $true
      $target = Join-Path $stage $entry.FullName.Replace('/', '\')
      Assert-AigcChild $target $stage
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
    }
    foreach ($required in $allowed) { if (-not $seen.ContainsKey($required)) { throw ('Missing signed file: ' + $required) } }
  } finally { $archive.Dispose() }
  Test-AigcSignature $stage
  $manifest = [xml][IO.File]::ReadAllText((Join-Path $stage 'CSXS\manifest.xml'))
  if ($manifest.ExtensionManifest.ExtensionBundleVersion -ne $script:AigcVersion) { throw 'Signed package version does not match the installer.' }
  return $stage
}

function Move-AigcCepAside($Paths) {
  if (-not (Test-Path -LiteralPath $Paths.Cep -PathType Container)) { return $null }
  $archive = Join-Path $Paths.Backups ('replaced-' + [guid]::NewGuid().ToString('N'))
  Assert-AigcChild $Paths.Cep (Join-Path $Paths.Root 'Adobe\CEP\extensions')
  Assert-AigcChild $archive $Paths.Backups
  [IO.Directory]::CreateDirectory($Paths.Backups) | Out-Null
  Move-Item -LiteralPath $Paths.Cep -Destination $archive
  return $archive
}

function Install-AigcPackage([string]$DataRoot) {
  $paths = Get-AigcPaths $DataRoot
  $helperSource = Join-Path $script:PackageRoot 'uxp-helper'
  foreach ($relative in $script:HelperPayload) {
    if (-not (Test-Path -LiteralPath (Join-Path $helperSource $relative) -PathType Leaf)) { throw 'Incomplete helper package.' }
  }
  $configuration = Get-AigcRegistry $paths
  $originalConfiguration = $configuration | ConvertTo-Json -Depth 32 | ConvertFrom-Json
  $cepSource = Expand-AigcSignedCep $paths
  $state = $null
  if (Test-Path -LiteralPath $paths.State) { $state = Read-AigcJson $paths.State }
  $currentManifest = Join-Path $paths.Cep 'CSXS\manifest.xml'
  $reuse = $state -and $state.Version -eq $script:AigcVersion -and -not $state.Restored -and
    (Test-Path -LiteralPath $currentManifest) -and ([IO.File]::ReadAllText($currentManifest).Contains('ExtensionBundleVersion="' + $script:AigcVersion + '"'))
  if (-not $reuse) {
    $backup = Join-Path $paths.Backups ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    $backupCep = Join-Path $backup 'CEP'
    $backupHelper = Join-Path $backup 'UXP-helper'
    Assert-AigcChild $backupCep $paths.Backups
    Assert-AigcChild $backupHelper $paths.Backups
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $hadCep = Test-Path -LiteralPath $paths.Cep -PathType Container
    $hadHelper = Test-Path -LiteralPath $paths.Helper -PathType Container
    if ($hadCep) { Copy-Item -LiteralPath $paths.Cep -Destination $backupCep -Recurse }
    if ($hadHelper) { Copy-Item -LiteralPath $paths.Helper -Destination $backupHelper -Recurse }
    $state = [pscustomobject]@{ Version = $script:AigcVersion; BackupCep = $backupCep; HadCep = [bool]$hadCep;
      BackupHelper = $backupHelper; HadHelper = [bool]$hadHelper;
      PreviousHelpers = @($configuration.plugins | Where-Object { $_.pluginId -eq 'aigcreturn' }); Restored = $false }
    Write-AigcJson $paths.State $state $paths.Root
  }
  $helperManifest = Read-AigcJson (Join-Path $helperSource 'manifest.json')
  $helperEntry = [pscustomobject]@{
    hostMinVersion = '25.0.0'; name = $helperManifest.name; pluginId = 'aigcreturn'; status = 'enabled'; type = 'uxp';
    versionString = $script:AigcVersion; path = ('$localPlugins\External\aigcreturn_' + $script:AigcVersion)
  }
  $tokenPath = $paths.Token
  if (-not (Test-Path -LiteralPath $tokenPath)) { $tokenPath = Join-Path $paths.Cep 'bridge-token.json' }
  $token = $null
  if (Test-Path -LiteralPath $tokenPath) {
    try { $candidate = (Read-AigcJson $tokenPath).token; if ($candidate -cmatch '^[a-f0-9]{64}$') { $token = $candidate } } catch {}
  }
  if (-not $token) {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  }
  $transaction = Join-Path $paths.Backups ('transaction-' + [guid]::NewGuid().ToString('N'))
  Assert-AigcChild $transaction $paths.Backups
  [IO.Directory]::CreateDirectory($transaction) | Out-Null
  $hadToken = Test-Path -LiteralPath $paths.Token -PathType Leaf
  $hadCurrentHelper = Test-Path -LiteralPath $paths.Helper -PathType Container
  if ($hadToken) { Copy-Item -LiteralPath $paths.Token -Destination (Join-Path $transaction 'bridge-token.json') }
  if ($hadCurrentHelper) { Copy-Item -LiteralPath $paths.Helper -Destination (Join-Path $transaction 'helper') -Recurse }
  $replaced = $null
  $cepCommitted = $false
  try {
    Copy-AigcPayload $helperSource $paths.Helper $script:HelperPayload $paths.Root
    Write-AigcJson $paths.Token ([pscustomobject]@{ token = $token }) $paths.Root
    Write-AigcJson (Join-Path $paths.Helper 'bridge-token.json') ([pscustomobject]@{ token = $token }) $paths.Root
    Set-AigcPlugins $configuration (@($configuration.plugins | Where-Object { $_.pluginId -ne 'aigcreturn' }) + @($helperEntry))
    Write-AigcJson $paths.Registry $configuration $paths.Root
    $replaced = Move-AigcCepAside $paths
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($paths.Cep)) | Out-Null
    Move-Item -LiteralPath $cepSource -Destination $paths.Cep
    $cepCommitted = $true
    Test-AigcSignature $paths.Cep
  } catch {
    $failure = $_
    if ($cepCommitted -and (Test-Path -LiteralPath $paths.Cep -PathType Container)) { Move-AigcCepAside $paths | Out-Null }
    if ($replaced -and (Test-Path -LiteralPath $replaced)) { Move-Item -LiteralPath $replaced -Destination $paths.Cep }
    Write-AigcJson $paths.Registry $originalConfiguration $paths.Root
    if (Test-Path -LiteralPath $paths.Helper -PathType Container) {
      Assert-AigcChild $paths.Helper (Join-Path $paths.Root 'Adobe\UXP\Plugins\External')
      Move-Item -LiteralPath $paths.Helper -Destination (Join-Path $transaction 'failed-helper')
    }
    if ($hadCurrentHelper) { Copy-Item -LiteralPath (Join-Path $transaction 'helper') -Destination $paths.Helper -Recurse }
    if ($hadToken) { Copy-Item -LiteralPath (Join-Path $transaction 'bridge-token.json') -Destination $paths.Token -Force }
    elseif (Test-Path -LiteralPath $paths.Token) { Move-Item -LiteralPath $paths.Token -Destination (Join-Path $transaction 'failed-token.json') }
    throw $failure
  }
  Write-Host 'Signed CEP 0.5.30 installed and verified. Restart Photoshop manually.'
  if ($replaced) { Write-Host ('Old extension removed from the load directory and preserved: ' + $replaced) }
  Write-Host 'The separate experimental UXP helper is NOT signed or verified to load on this computer.'
  Write-Host ('Backup: ' + $state.BackupCep)
}

function Disable-AigcPackage([string]$DataRoot) {
  $paths = Get-AigcPaths $DataRoot
  $configuration = Get-AigcRegistry $paths
  Set-AigcPlugins $configuration @($configuration.plugins | Where-Object { $_.pluginId -ne 'aigcreturn' })
  Write-AigcJson $paths.Registry $configuration $paths.Root
  $external = Join-Path $paths.Root 'Adobe\UXP\Plugins\External'
  $targets = @($paths.Cep, (Join-Path $paths.Root 'Adobe\AIGCSelectionRefiner'))
  if (Test-Path -LiteralPath $external -PathType Container) {
    $targets += @(Get-ChildItem -LiteralPath $external -Directory -Filter 'aigcreturn_*' | ForEach-Object { $_.FullName })
  }
  foreach ($target in $targets) {
    Assert-AigcChild $target (Join-Path $paths.Root 'Adobe')
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  Write-Host 'AIGC plugin files removed. PSD files and other plugins are preserved.'
}

function Restore-AigcPackage([string]$DataRoot) {
  $paths = Get-AigcPaths $DataRoot
  if (-not (Test-Path -LiteralPath $paths.State)) { throw 'No installation backup was found.' }
  $state = Read-AigcJson $paths.State
  Assert-AigcChild $state.BackupCep $paths.Backups
  $configuration = Get-AigcRegistry $paths
  if ($state.HadHelper) {
    Assert-AigcChild $state.BackupHelper $paths.Backups
    Assert-AigcChild $paths.Helper $paths.Root
    if (-not (Test-Path -LiteralPath $state.BackupHelper -PathType Container)) { throw 'The previous UXP helper backup is missing.' }
  }
  if ($state.HadCep) {
    if (-not (Test-Path -LiteralPath $state.BackupCep -PathType Container)) { throw 'The previous CEP backup is missing.' }
    Move-AigcCepAside $paths | Out-Null
    [IO.Directory]::CreateDirectory($paths.Cep) | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $state.BackupCep -Force) {
      Copy-Item -LiteralPath $entry.FullName -Destination $paths.Cep -Recurse -Force
    }
  } else {
    $manifest = Join-Path $paths.Cep 'CSXS\manifest.xml'
    if (Test-Path -LiteralPath $manifest) { Move-Item -LiteralPath $manifest -Destination ($manifest + '.disabled') -Force }
  }
  if ($state.HadHelper) {
    [IO.Directory]::CreateDirectory($paths.Helper) | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $state.BackupHelper -Force) {
      Copy-Item -LiteralPath $entry.FullName -Destination $paths.Helper -Recurse -Force
    }
  }
  Set-AigcPlugins $configuration (@($configuration.plugins | Where-Object { $_.pluginId -ne 'aigcreturn' }) + @($state.PreviousHelpers))
  Write-AigcJson $paths.Registry $configuration $paths.Root
  $state.Restored = $true
  Write-AigcJson $paths.State $state $paths.Root
  Write-Host 'Previous CEP restored. Restart Photoshop manually. Other plugin entries were preserved.'
}

if ($LibraryOnly) { return }
if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { throw 'Save your work and close Photoshop before installing, disabling or restoring.' }
switch ($Mode) {
  'Install' { Install-AigcPackage }
  'Disable' { Disable-AigcPackage }
  'Restore' { Restore-AigcPackage }
}
