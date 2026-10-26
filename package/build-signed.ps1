param([string]$Certificate, [string]$PasswordFile)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1') -LibraryOnly
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$signer = Join-Path $workspace 'tools\adobe-signing\ZXPSignCmd.exe'
if (-not $Certificate) { $Certificate = Join-Path $workspace 'tools\adobe-signing\private\publisher.p12' }
if (-not $PasswordFile) { $PasswordFile = Join-Path $workspace 'tools\adobe-signing\private\password.dpapi' }
$credential = New-Object Management.Automation.PSCredential('publisher', (ConvertTo-SecureString ([IO.File]::ReadAllText($PasswordFile))))
$stage = Join-Path $workspace ('outputs\signed-build-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stage) | Out-Null
$payload = Join-Path $stage 'payload'
Copy-AigcPayload (Join-Path $PSScriptRoot 'AIGCSelectionRefiner') $payload $script:CepPayload $workspace
$signedPackage = Join-Path $stage 'AIGCSelectionRefiner.zxp'
$destination = Join-Path $PSScriptRoot 'AIGCSelectionRefiner.zxp'
& $signer -sign $payload $signedPackage $Certificate $credential.GetNetworkCredential().Password
if ($LASTEXITCODE -ne 0) { throw 'Signing failed.' }
& $signer -verify $signedPackage
if ($LASTEXITCODE -ne 0) { throw 'Signed package validation failed.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($signedPackage)
try {
  $reader = New-Object IO.StreamReader($archive.GetEntry('CSXS/manifest.xml').Open())
  try { $manifest = [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
  if ($manifest.ExtensionManifest.ExtensionBundleVersion -ne $script:AigcVersion) { throw 'Signed build contains an unexpected version.' }
} finally { $archive.Dispose() }
Assert-AigcChild $destination $script:PackageRoot
Move-Item -LiteralPath $signedPackage -Destination $destination -Force
$tools = Join-Path $PSScriptRoot 'tools'
[IO.Directory]::CreateDirectory($tools) | Out-Null
Copy-Item -LiteralPath $signer -Destination (Join-Path $tools 'ZXPSignCmd.exe') -Force
Copy-Item -LiteralPath (Join-Path $workspace 'tools\adobe-signing\LICENSE.txt') -Destination (Join-Path $tools 'Adobe-tool-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $workspace 'tools\adobe-signing\Adobe-tool-LICENSE.pdf') -Destination (Join-Path $tools 'Adobe-tool-LICENSE.pdf') -Force
$integrity = [pscustomobject]@{
  Version = $script:AigcVersion
  PackageSHA256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
  VerifierSHA256 = (Get-FileHash -LiteralPath $signer -Algorithm SHA256).Hash
}
Write-AigcJson (Join-Path $PSScriptRoot 'package-integrity.json') $integrity $workspace
Write-Host 'Signed whitelist-only CEP generated. Private certificate and credentials are excluded from distribution.'
