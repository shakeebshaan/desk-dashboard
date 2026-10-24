# Runs the dashboard hub and restarts it if it exits (crash, network loss). Below-normal priority, log in data\.
# Started by the scheduled task from setup-hub-task.ps1. ASCII-only (PS 5.1).
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$data = Join-Path $root "data"
New-Item -ItemType Directory -Force $data | Out-Null
$log = Join-Path $data "hub.log"
$node = (Get-Command node).Source
$backoff = 5
while ($true) {
    $started = Get-Date
    # Localhost only. The phone reaches the hub through the relay (outbound connections only, docs/SECURITY.md);
    # no LAN, tailnet or public listener.
    $env:HUB_HOST = "127.0.0.1"
    Add-Content $log ("{0} hub host {1}" -f $started.ToString("s"), $env:HUB_HOST)
    Add-Content $log ("{0} starting hub" -f $started.ToString("s"))
    $p = Start-Process -FilePath $node -ArgumentList "hub\src\index.js" -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardOutput (Join-Path $data "hub.out.log") -RedirectStandardError (Join-Path $data "hub.err.log")
    $null = $p.Handle
    try { $p.PriorityClass = "BelowNormal" } catch {}
    $p.WaitForExit()
    Add-Content $log ("{0} hub exited with {1}" -f (Get-Date).ToString("s"), $p.ExitCode)
    # keep the last run's output
    foreach ($f in "hub.out.log", "hub.err.log") {
        $src = Join-Path $data $f
        if (Test-Path $src) { Get-Content $src -Tail 200 | Add-Content $log }
    }
    if (((Get-Date) - $started).TotalMinutes -gt 10) { $backoff = 5 } else { $backoff = [Math]::Min($backoff * 2, 300) }
    Start-Sleep -Seconds $backoff
}
