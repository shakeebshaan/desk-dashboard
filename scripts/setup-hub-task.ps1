# Registers Scheduled Task "Desk dashboard hub": start-hub.ps1 at boot (S4U, no stored password), restarted by
# Task Scheduler if the runner dies. -Remove deletes it. Registering it makes the bot live.
# ASCII-only (PS 5.1).
param([switch]$Remove)
$taskName = "Desk dashboard hub"
if ($Remove) { schtasks /Delete /TN $taskName /F; return }
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $dir "start-hub.ps1"
$sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\$taskName</URI>
    <Description>Private hub for the owner's phone dashboard (the Telegram bot long-polling + relay link to ntfy.sh, end-to-end encrypted, localhost only). Log: data\hub.log.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>$sid</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Priority>7</Priority>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Triggers>
    <BootTrigger><Delay>PT1M</Delay></BootTrigger>
    <RegistrationTrigger><Delay>PT10S</Delay></RegistrationTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$script"</Arguments>
    </Exec>
  </Actions>
</Task>
"@
$tmp = Join-Path $env:TEMP "desk-dashboard-hub-task.xml"
[System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UnicodeEncoding($false, $true)))
schtasks /Create /TN $taskName /XML $tmp /F
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
schtasks /Query /TN $taskName /FO LIST | Select-String "TaskName|Status|Next Run"
