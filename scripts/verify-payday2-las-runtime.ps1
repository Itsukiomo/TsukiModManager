param(
    [string]$GameRoot = 'D:\SteamLibrary\steamapps\common\PAYDAY 2',
    [string]$SourceRoot = 'D:\TsukiReleaseQualification\dependencies-1791651146336\games\0-builtin.payday2',
    [int]$WaitSeconds = 75
)
$ErrorActionPreference = 'Stop'
if (Get-Process PAYDAY2 -ErrorAction SilentlyContinue) { throw 'Close PAYDAY 2 before testing.' }
$game = (Resolve-Path -LiteralPath $GameRoot).Path
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
if (!(Test-Path -LiteralPath "$game\PAYDAY2.exe")) { throw 'Missing game identity.' }
$backup = "D:\TsukiReleaseQualification\las-runtime-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Path $backup | Out-Null
$manifest = @()
$roots = @('WSOCK32.dll', 'mods\base', 'mods\BeardLib', 'assets\mod_overrides\Legendary Armour Skins', 'assets\mod_overrides\Loona LAS')
$probe = Join-Path $PSScriptRoot 'fixtures\las-runtime-probe'
foreach ($relative in $roots) {
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $source $relative) -File -Recurse) {
        $rel = $file.FullName.Substring($source.Length + 1)
        $destination = [IO.Path]::GetFullPath((Join-Path $game $rel))
        if (!$destination.StartsWith($game + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination escaped game root.' }
        $before = if (Test-Path -LiteralPath $destination) { (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash } else { $null }
        $manifest += [pscustomobject]@{ path=$rel; source=$file.FullName; before=$before; after=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
        if ($before) {
            $saved = Join-Path $backup $rel
            New-Item -ItemType Directory -Path (Split-Path $saved) -Force | Out-Null
            Copy-Item -LiteralPath $destination -Destination $saved
        }
    }
}
foreach ($file in Get-ChildItem -LiteralPath $probe -File) {
    $relative = 'mods\TsukiLASRuntimeProbe\' + $file.Name
    if (Test-Path -LiteralPath (Join-Path $game $relative)) { throw 'Probe already exists; refusing to overwrite.' }
    $manifest += [pscustomobject]@{ path=$relative; source=$file.FullName; before=$null; after=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$backup\manifest.json"
try {
    foreach ($entry in $manifest) {
        $destination = Join-Path $game $entry.path
        New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
        Copy-Item -LiteralPath $entry.source -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.after) { throw 'Deployment hash mismatch.' }
    }
    Start-Process 'steam://rungameid/218620'
    Start-Sleep -Seconds $WaitSeconds
    $running = @(Get-Process PAYDAY2 -ErrorAction SilentlyContinue)
    $running | Select-Object Id,Responding,MainWindowTitle | ConvertTo-Json | Set-Content "$backup\process.json"
    Get-ChildItem -LiteralPath "$game\mods\logs" -File | Copy-Item -Destination $backup
    if (Test-Path "$env:LOCALAPPDATA\PAYDAY 2\crash.txt") { Copy-Item "$env:LOCALAPPDATA\PAYDAY 2\crash.txt" "$backup\crash.txt" }
} finally {
    Get-Process PAYDAY2 -ErrorAction SilentlyContinue | Stop-Process
    Start-Sleep -Seconds 2
    $restored = @()
    foreach ($entry in $manifest) {
        $destination = Join-Path $game $entry.path
        if (!(Test-Path -LiteralPath $destination) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.after) {
            throw "Test file changed externally; preserved for manual recovery: $destination"
        }
        if ($entry.before) { Copy-Item -LiteralPath (Join-Path $backup $entry.path) -Destination $destination -Force }
        else { Remove-Item -LiteralPath $destination }
        $restored += $entry.path
    }
    $restored | ConvertTo-Json | Set-Content "$backup\restored.json"
}
Write-Output "Runtime evidence and restored-file manifest: $backup"
