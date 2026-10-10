param([Parameter(Mandatory=$true)][string]$Installer, [string]$LegacyInstaller, [string]$QualificationRoot)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseVersion = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$parent = if($QualificationRoot) { [IO.Path]::GetFullPath($QualificationRoot) } else { Join-Path $workspace 'src-tauri\target\release-qualification' }
$root = Join-Path $parent ('installer-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$env:TSUKI_RELEASE_QA_ROOT = $parent
if(-not $LegacyInstaller) { $LegacyInstaller = Join-Path $workspace 'src-tauri\target\release-qualification\legacy\Tsuki.Mod.Manager_1.8.2_x64-setup.exe' }
$legacy = (Resolve-Path -LiteralPath $LegacyInstaller).Path
New-Item -ItemType Directory -Path $root | Out-Null
$keys = @(
    'Software\Microsoft\Windows\CurrentVersion\Uninstall\Tsuki Mod Manager',
    'Software\jeffe\Tsuki Mod Manager'
)
$backups = @()
$installedApp = Join-Path $env:LOCALAPPDATA 'Tsuki Mod Manager\tsukimodmanagerapp.exe'
$originalHash = (Get-FileHash -LiteralPath $installedApp -Algorithm SHA256).Hash
$report = @{ root=$root; installer=$installerPath; checks=@(); passed=$false }
function Run-Installer([string]$file, [string]$destination) {
    $resolved = [IO.Path]::GetFullPath($destination)
    if (-not $resolved.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer target escaped qualification directory' }
    $process = Start-Process -FilePath $file -ArgumentList "/S /NS /D=$resolved" -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { Stop-Process -Id $process.Id; throw 'Installer timed out' }
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    if (-not (Test-Path -LiteralPath (Join-Path $resolved 'tsukimodmanagerapp.exe'))) { throw 'Installed executable missing' }
}
try {
    for ($index=0; $index -lt $keys.Count; $index++) {
        $key = $keys[$index]
        $backup = Join-Path $root "registration-$index.reg"
        $exists = Test-Path -LiteralPath "HKCU:\$key"
        if ($exists) {
            & reg.exe export "HKCU\$key" $backup /y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Registry backup failed' }
        }
        $backups += @{ key=$key; path=$backup; existed=$exists }
    }
    $backups | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'registration-backups.json')
    foreach ($item in $backups) { if ($item.existed) { Remove-Item -LiteralPath "HKCU:\$($item.key)" -Recurse } }
    $clean = Join-Path $root 'clean-install'
    Run-Installer $installerPath $clean
    if ((Get-ItemProperty -LiteralPath "HKCU:\$($keys[0])").DisplayVersion -ne $releaseVersion) { throw 'Installer registered wrong version' }
    $report.checks += 'clean silent NSIS installation and Windows version registration'
    & node (Join-Path $PSScriptRoot 'native-release-smoke.mjs') (Join-Path $clean 'tsukimodmanagerapp.exe') clean (Join-Path $root 'clean-state')
    if ($LASTEXITCODE -ne 0) { throw 'Clean native startup failed' }
    foreach ($key in $keys) { if (Test-Path -LiteralPath "HKCU:\$key") { Remove-Item -LiteralPath "HKCU:\$key" -Recurse } }
    $upgrade = Join-Path $root 'upgrade-install'
    Run-Installer $legacy $upgrade
    & node (Join-Path $PSScriptRoot 'native-release-smoke.mjs') (Join-Path $upgrade 'tsukimodmanagerapp.exe') legacy (Join-Path $root 'upgrade-state')
    if ($LASTEXITCODE -ne 0) { throw 'Legacy native setup failed' }
    Run-Installer $installerPath $upgrade
    & node (Join-Path $PSScriptRoot 'native-release-smoke.mjs') (Join-Path $upgrade 'tsukimodmanagerapp.exe') upgrade (Join-Path $root 'upgrade-state')
    if ($LASTEXITCODE -ne 0) { throw 'Native upgrade migration failed' }
    $report.checks += "actual 1.8.2 NSIS installation upgraded to $releaseVersion with preserved app data"
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    foreach ($item in $backups) {
        $current = "HKCU:\$($item.key)"
        if (Test-Path -LiteralPath $current) { Remove-Item -LiteralPath $current -Recurse }
        if ($item.existed) {
            & reg.exe import $item.path | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Restore registry from $($item.path)" }
        }
    }
    $report.registrationRestored = $true
    $report.existingExecutableUnchanged = (Get-FileHash -LiteralPath $installedApp -Algorithm SHA256).Hash -eq $originalHash
    $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'installer-report.json')
    if (-not $report.existingExecutableUnchanged) { throw 'Existing app executable changed during qualification' }
    Write-Output "Installer qualification report: $root\installer-report.json"
}
