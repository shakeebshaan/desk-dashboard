# Builds the debug APK for sideloading: C:\tmp\desk-dashboard\desk-dashboard.apk
# Gradle runs at below-normal priority with a hard timeout.
# ASCII-only (PS 5.1).
param([int]$TimeoutMin = 20)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$app = Join-Path $root "app"
$android = Join-Path $app "android"
$out = "C:\tmp\desk-dashboard"
New-Item -ItemType Directory -Force $out | Out-Null
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Push-Location $app
try {
    node scripts/vendor.js
    if ($LASTEXITCODE -ne 0) { throw "vendor failed" }
    npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }
} finally { Pop-Location }

# Bake the hub's UI-signing PUBLIC key into the APK copy of the shell (the repo copy stays empty): the phone then
# runs only UI bundles signed by this hub. The secret half stays in the secrets folder.
$k = node (Join-Path $root "scripts\ui-pubkey.mjs") | ConvertFrom-Json
if ($k.pub -notmatch '^[A-Za-z0-9_-]{43}$') { throw "no UI public key" }
$uikey = Join-Path $android "app\src\main\assets\public\shell\uikey.js"
Set-Content -Encoding ascii -Path $uikey -Value ("// Baked by build-apk.ps1`nwindow.__UI_PUB = `"{0}`";`nwindow.__UI_BUILTIN_V = {1};" -f $k.pub, [int]$k.builtin)
Write-Host ("UI key baked: {0}... (built-in UI v{1})" -f $k.pub.Substring(0, 8), $k.builtin)

$log = Join-Path $out "gradle-build.log"
$p = Start-Process -FilePath (Join-Path $android "gradlew.bat") -ArgumentList "assembleDebug", "--no-daemon", "--console=plain" `
    -WorkingDirectory $android -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$null = $p.Handle  # cache the handle, else ExitCode stays empty after WaitForExit(timeout)
try { $p.PriorityClass = "BelowNormal" } catch {}
if (-not $p.WaitForExit($TimeoutMin * 60 * 1000)) {
    Stop-Process -Id $p.Id -Force
    throw "gradle timed out after $TimeoutMin min (log: $log)"
}
if ($p.ExitCode -ne 0) { Get-Content "$log.err" -Tail 30; throw "gradle failed ($($p.ExitCode)), log: $log" }

$apk = "C:\tmp\desk-dashboard\gradle\app\outputs\apk\debug\app-debug.apk"
Copy-Item $apk (Join-Path $out "desk-dashboard.apk") -Force
Get-Item (Join-Path $out "desk-dashboard.apk") | Select-Object FullName, Length, LastWriteTime
