$ErrorActionPreference='Stop'
$game='D:\SteamLibrary\steamapps\common\PAYDAY 2'
$root='D:\TsukiReleaseQualification\payday2-runtime-20261010'
if(Test-Path -LiteralPath $root) { throw 'Do not overwrite a previous runtime verification backup' }
if(Get-Process PAYDAY2,payday2_win32_release -ErrorAction SilentlyContinue) { throw 'Close PAYDAY 2 before verification' }
$exe=Join-Path $game 'PAYDAY2.exe'
if(-not(Test-Path -LiteralPath $exe)) { throw 'Current PAYDAY 2 executable missing' }
New-Item -ItemType Directory -Path $root | Out-Null
$archive='D:\TsukiReleaseQualification\20261010-qualification\superblt-x64.zip'
& 'C:\Program Files\7-Zip\7z.exe' x $archive "-o$root\loader" WSOCK32.dll -y | Out-Null
if($LASTEXITCODE -ne 0) { throw 'Loader extraction failed' }
Invoke-WebRequest -Uri 'https://github.com/diesel-modding/PAYDAY2-SuperBLT-Lua/archive/refs/heads/master.zip' -OutFile (Join-Path $root 'base.zip')
Expand-Archive -LiteralPath (Join-Path $root 'base.zip') -DestinationPath (Join-Path $root 'base-source')
$newBase=Join-Path $root 'base-source\PAYDAY2-SuperBLT-Lua-master'
if(-not(Test-Path -LiteralPath (Join-Path $newBase 'mod.txt'))) { throw 'Official base mod identity missing' }
function Machine([string]$path) { $bytes=[IO.File]::ReadAllBytes($path); $offset=[BitConverter]::ToInt32($bytes,60); return [BitConverter]::ToUInt16($bytes,$offset+4) }
$dll=Join-Path $game 'WSOCK32.dll'
$base=Join-Path $game 'mods\base'
$probe=Join-Path $game 'mods\TsukiReleaseProbe'
if(Test-Path -LiteralPath $probe) { throw 'Probe mod already exists' }
if((Machine $exe) -ne 0x8664 -or (Machine (Join-Path $root 'loader\WSOCK32.dll')) -ne 0x8664) { throw 'Runtime architecture mismatch' }
$oldDll=Join-Path $root 'WSOCK32.dll.original'
$oldBase=Join-Path $root 'base.original'
$manifest=@{game=$game; gameExecutableSha256=(Get-FileHash -LiteralPath $exe).Hash; originalDllSha256=(Get-FileHash -LiteralPath $dll).Hash; newDllSha256=(Get-FileHash -LiteralPath (Join-Path $root 'loader\WSOCK32.dll')).Hash; baseFiles=@(); probeLoaded=$false; restorationVerified=$false}
if(Test-Path -LiteralPath $base) {
    $manifest.baseFiles=@(Get-ChildItem -LiteralPath $base -Recurse -File | ForEach-Object { @{relative=$_.FullName.Substring($base.Length+1); sha256=(Get-FileHash -LiteralPath $_.FullName).Hash} })
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'deployment-manifest.json')
Copy-Item -LiteralPath $dll -Destination $oldDll
$baseMoved=$false
$dllChanged=$false
try {
    if(Test-Path -LiteralPath $base) {
        $resolved=(Resolve-Path -LiteralPath $base).Path
        if($resolved -ne 'D:\SteamLibrary\steamapps\common\PAYDAY 2\mods\base' -or [IO.Path]::GetFullPath($oldBase) -ne 'D:\TsukiReleaseQualification\payday2-runtime-20261010\base.original') { throw 'Unexpected base backup paths' }
        Move-Item -LiteralPath $base -Destination $oldBase
        $baseMoved=$true
    }
    Copy-Item -LiteralPath $newBase -Destination $base -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release-probe') -Destination $probe -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'loader\WSOCK32.dll') -Destination $dll -Force
    $dllChanged=$true
    if((Get-FileHash -LiteralPath $dll).Hash -ne $manifest.newDllSha256) { throw 'Deployed DLL hash mismatch' }
    $started=Get-Date
    Start-Process -FilePath $exe -WorkingDirectory $game -WindowStyle Hidden | Out-Null
    for($attempt=0;$attempt -lt 90;$attempt++) {
        Start-Sleep -Seconds 1
        $logs=@(Get-ChildItem -LiteralPath (Join-Path $game 'mods\logs') -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -ge $started)
        foreach($log in $logs) {
            if(Select-String -LiteralPath $log.FullName -SimpleMatch '[TsukiReleaseProbe]' -Quiet) {
                Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $root 'fresh-runtime.log')
                $manifest.probeLoaded=$true
                break
            }
        }
        if($manifest.probeLoaded) { break }
    }
    if(-not $manifest.probeLoaded) { throw 'Fresh startup Lua probe was not observed' }
} catch { $manifest.error=$_.Exception.Message }
finally {
    Get-Process PAYDAY2 -ErrorAction SilentlyContinue | ForEach-Object { if($_.Path -eq $exe) { if(-not $_.CloseMainWindow()) { Stop-Process -Id $_.Id }; if(-not $_.WaitForExit(15000)) { Stop-Process -Id $_.Id } } }
    foreach($path in @($base,$probe)) {
        if(Test-Path -LiteralPath $path) {
            $resolved=(Resolve-Path -LiteralPath $path).Path
            if(-not $resolved.StartsWith($game+'\mods\',[StringComparison]::OrdinalIgnoreCase) -or $resolved -notin @($base,$probe)) { throw 'Unexpected generated mod removal target' }
            if($path -eq $base -and -not $baseMoved) { throw 'Refusing to remove an unbacked original base' }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
    if($baseMoved) { Move-Item -LiteralPath $oldBase -Destination $base }
    if($dllChanged) { Copy-Item -LiteralPath $oldDll -Destination $dll -Force }
    if((Get-FileHash -LiteralPath $dll).Hash -ne $manifest.originalDllSha256) { throw 'Original loader restoration mismatch' }
    foreach($file in $manifest.baseFiles) { if((Get-FileHash -LiteralPath (Join-Path $base $file.relative)).Hash -ne $file.sha256) { throw 'Original base restoration mismatch' } }
    if((Get-FileHash -LiteralPath $exe).Hash -ne $manifest.gameExecutableSha256) { throw 'Game executable changed' }
    $manifest.restorationVerified=$true
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'deployment-manifest.json')
}
Write-Output "PAYDAY 2 runtime probe loaded: $($manifest.probeLoaded); originals restored: $($manifest.restorationVerified)"
if(-not $manifest.probeLoaded) { throw $manifest.error }
