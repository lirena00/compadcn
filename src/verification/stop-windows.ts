import { execa } from "execa";
import { join } from "node:path";

// taskkill /T alone can miss a child created between its process-tree snapshot
// and killing npm's command wrapper. Keep historical parent identities and scan
// after each stop, including children whose parent has already exited. No process
// arguments or environment values are read or returned.
export async function stopWindowsVerification(pid: number, started: number): Promise<boolean> {
  const script = `
$ErrorActionPreference = 'Stop'
$verificationRootPid = ${pid}
$verificationStarted = [datetime]::Parse('${new Date(started).toISOString()}').ToUniversalTime()
$verificationOwned = @{}
$verificationOwned[$verificationRootPid] = $null
$verificationEmpty = 0
for ($verificationRound = 0; $verificationRound -lt 12; $verificationRound++) {
  $verificationProcesses = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $null -ne $_.CreationDate })
  $verificationCurrent = @{}
  foreach ($verificationProcess in $verificationProcesses) { $verificationCurrent[[int]$verificationProcess.ProcessId] = $verificationProcess }
  if ($verificationCurrent.ContainsKey($verificationRootPid) -and $null -eq $verificationOwned[$verificationRootPid]) {
    $verificationOwned[$verificationRootPid] = $verificationCurrent[$verificationRootPid].CreationDate.ToUniversalTime().Ticks
  }
  $verificationAdded = $true
  while ($verificationAdded) {
    $verificationAdded = $false
    foreach ($verificationProcess in $verificationProcesses) {
      $verificationPid = [int]$verificationProcess.ProcessId
      $verificationParent = [int]$verificationProcess.ParentProcessId
      $verificationBirth = $verificationProcess.CreationDate.ToUniversalTime()
      if ($verificationOwned.ContainsKey($verificationPid) -or !$verificationOwned.ContainsKey($verificationParent) -or $verificationBirth -lt $verificationStarted) { continue }
      if ($verificationCurrent.ContainsKey($verificationParent) -and $null -ne $verificationOwned[$verificationParent]) {
        $verificationParentBirth = $verificationCurrent[$verificationParent].CreationDate.ToUniversalTime().Ticks
        if ($verificationParentBirth -ne $verificationOwned[$verificationParent] -and $verificationBirth.Ticks -ge $verificationParentBirth) { continue }
      }
      $verificationOwned[$verificationPid] = $verificationBirth.Ticks
      $verificationAdded = $true
    }
  }
  $verificationAlive = 0
  foreach ($verificationPid in @($verificationOwned.Keys)) {
    if (!$verificationCurrent.ContainsKey($verificationPid)) { continue }
    $verificationProcess = $verificationCurrent[$verificationPid]
    if ($null -ne $verificationOwned[$verificationPid] -and $verificationProcess.CreationDate.ToUniversalTime().Ticks -ne $verificationOwned[$verificationPid]) { continue }
    $verificationAlive++
    Stop-Process -Id $verificationPid -Force -ErrorAction SilentlyContinue
  }
  if ($verificationAlive -eq 0) { $verificationEmpty++ } else { $verificationEmpty = 0 }
  if ($verificationEmpty -ge 2) { Write-Output 'stopped'; exit 0 }
  Start-Sleep -Milliseconds 100
}
exit 1
`;
  try {
    const result = await execa(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { reject: false, stdin: "ignore", stdout: "pipe", stderr: "ignore", maxBuffer: 1024, timeout: 15000, forceKillAfterDelay: 1000, windowsHide: true });
    return !result.failed && result.stdout.trim() === "stopped";
  } catch { return false; }
}
