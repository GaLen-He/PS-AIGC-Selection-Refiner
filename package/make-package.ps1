param([string]$Destination)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install.ps1') -LibraryOnly
$outputRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Destination) { $Destination = Join-Path $outputRoot 'AIGC选区提交-整图分层-0.5.30.zip' }
$Destination = [IO.Path]::GetFullPath($Destination)
Assert-AigcChild $Destination $outputRoot
$files = @('安装.bat', '卸载.bat', '回退旧版.bat', 'install.ps1', '安装说明.txt', '开发说明.md',
  'AIGCSelectionRefiner.zxp', 'package-integrity.json', 'tools\ZXPSignCmd.exe', 'tools\Adobe-tool-LICENSE.txt', 'tools\Adobe-tool-LICENSE.pdf')
Test-AigcSignature (Join-Path $PSScriptRoot 'AIGCSelectionRefiner.zxp')
$files += @($script:HelperPayload | ForEach-Object { 'uxp-helper\' + $_ })
$manualRoot = Join-Path $PSScriptRoot '手动安装'
$files += @(Get-ChildItem -LiteralPath $manualRoot -Recurse -File | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) })
foreach ($relative in $files) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $relative) -PathType Leaf)) { throw ('Missing payload: ' + $relative) }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($relative in $files) {
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $PSScriptRoot $relative), $relative.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
Write-Host ('Created ' + $Destination + ' (' + $files.Count + ' files)')
