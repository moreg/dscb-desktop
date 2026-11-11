/** Windows-only handle inspection and narrowly scoped helper cleanup.
 * DuplicateHandle uses SAME_ACCESS (2), never CLOSE_SOURCE (1).
 * Closing another process's individual handles can corrupt that process.
 */
export const windowsProjectLockScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$directory = [IO.Path]::GetFullPath($env:AI_WRITER_LOCK_DIRECTORY).TrimEnd('\')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public sealed class ProjectDirectoryHandles {
 public int Pid;
 public string[] Paths;
}
public static class ProjectDirectoryLockNative {
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr data, int size, out int needed);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate, uint access, bool inherit, uint options);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder name, uint size, uint flags);
 [StructLayout(LayoutKind.Sequential)] struct Entry {
  public IntPtr Object; public UIntPtr Pid; public IntPtr Handle; public uint Access;
  public ushort Backtrace; public ushort Type; public uint Attributes; public uint Reserved;
 }
 public static ProjectDirectoryHandles[] Find(string seedPath, string target) {
  var paths = new Dictionary<int, HashSet<string>>();
  using (var seed = File.Open(seedPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
   IntPtr data = IntPtr.Zero; int size = 1048576, needed;
   try {
    int status;
    do {
     if (data != IntPtr.Zero) { Marshal.FreeHGlobal(data); data = IntPtr.Zero; }
     if (size > 67108864) throw new Exception("Handle table exceeds limit.");
     data = Marshal.AllocHGlobal(size);
     status = NtQuerySystemInformation(64, data, size, out needed);
     if (status == unchecked((int)0xC0000004)) size = Math.Max(size * 2, needed + 65536);
    } while (status == unchecked((int)0xC0000004));
    if (status < 0) throw new Exception("Handle inspection unavailable.");
    long count = Marshal.ReadIntPtr(data).ToInt64(); int entrySize = Marshal.SizeOf(typeof(Entry));
    if (count < 0 || count > (size - 2 * IntPtr.Size) / entrySize) throw new Exception("Invalid handle table.");
    int self = Process.GetCurrentProcess().Id; ushort fileType = 0;
    for (int i = 0; i < count; i++) {
     var entry = (Entry)Marshal.PtrToStructure(IntPtr.Add(data, 2 * IntPtr.Size + i * entrySize), typeof(Entry));
     if (entry.Pid.ToUInt64() == (ulong)self && entry.Handle == seed.SafeFileHandle.DangerousGetHandle()) { fileType = entry.Type; break; }
    }
    if (fileType == 0) throw new Exception("File handle type unavailable.");
    var processes = new Dictionary<int, IntPtr>();
    try {
     for (int i = 0; i < count; i++) {
      var entry = (Entry)Marshal.PtrToStructure(IntPtr.Add(data, 2 * IntPtr.Size + i * entrySize), typeof(Entry));
      if (entry.Type != fileType || entry.Pid.ToUInt64() > int.MaxValue) continue;
      int pid = (int)entry.Pid.ToUInt64(); IntPtr process;
      if (!processes.TryGetValue(pid, out process)) { process = OpenProcess(0x40, false, pid); processes[pid] = process; }
      if (process == IntPtr.Zero) continue;
      IntPtr copy;
      if (!DuplicateHandle(process, entry.Handle, GetCurrentProcess(), out copy, 0, false, 2)) continue;
      try {
       if (GetFileType(copy) != 1) continue;
       var name = new StringBuilder(32768); uint length = GetFinalPathNameByHandle(copy, name, (uint)name.Capacity, 0);
       if (length == 0 || length >= name.Capacity) continue;
       string value = name.ToString();
       if (value.StartsWith(@"\\?\UNC\")) value = @"\\" + value.Substring(8);
       else if (value.StartsWith(@"\\?\")) value = value.Substring(4);
       if (!value.Equals(target, StringComparison.OrdinalIgnoreCase) && !value.StartsWith(target + @"\", StringComparison.OrdinalIgnoreCase)) continue;
       HashSet<string> found;
       if (!paths.TryGetValue(pid, out found)) { found = new HashSet<string>(StringComparer.OrdinalIgnoreCase); paths[pid] = found; }
       found.Add(value);
      } finally { CloseHandle(copy); }
     }
    } finally { foreach (var process in processes.Values) if (process != IntPtr.Zero) CloseHandle(process); }
   } finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); }
  }
  var result = new List<ProjectDirectoryHandles>();
  foreach (var item in paths) { var values = new string[item.Value.Count]; item.Value.CopyTo(values); result.Add(new ProjectDirectoryHandles { Pid = item.Key, Paths = values }); }
  return result.ToArray();
 }
}
'@
function Test-PassiveConsole($item) {
 return $item.Name -eq 'conhost.exe' -and $item.ExecutablePath -eq (Join-Path $env:SystemRoot 'System32\conhost.exe')
}
function Get-LockSnapshot {
 $all = @(Get-CimInstance Win32_Process)
 $byId = @{}
 foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
 $connections = @{}
 $networkKnown = $true
 try { foreach ($connection in @(Get-NetTCPConnection -ErrorAction Stop)) { $connections[[int]$connection.OwningProcess] = $true } }
 catch { $networkKnown = $false }
 $holders = @(foreach ($held in [ProjectDirectoryLockNative]::Find((Join-Path $PSHOME 'powershell.exe'), $directory)) {
  $item = $byId[[int]$held.Pid]
  if (-not $item) { continue }
  $runtime = $null
  try {
   $runtime = [Diagnostics.Process]::GetProcessById($held.Pid)
   $null = $runtime.Handle
   $ancestors = @()
   $parentId = [int]$item.ParentProcessId
   for ($index = 0; $index -lt 3; $index++) {
    $parent = $byId[$parentId]
    if (-not $parent) { break }
    $ancestors += @{ pid = $parentId; executablePath = [string]$parent.ExecutablePath; commandLine = [string]$parent.CommandLine }
    $parentId = [int]$parent.ParentProcessId
   }
   @{
    pid = [int]$held.Pid; name = [string]$item.Name; executablePath = [string]$item.ExecutablePath
    commandLine = [string]$item.CommandLine; startTimeTicks = $runtime.StartTime.ToUniversalTime().Ticks.ToString()
    cpuSeconds = $runtime.TotalProcessorTime.TotalSeconds; ageSeconds = ([DateTime]::UtcNow - $runtime.StartTime.ToUniversalTime()).TotalSeconds
    sessionId = $runtime.SessionId; hasWindow = ($runtime.MainWindowHandle -ne [IntPtr]::Zero)
    hasConnection = $connections.ContainsKey([int]$held.Pid); paths = @($held.Paths)
    childPids = @($all | Where-Object { $_.ParentProcessId -eq $held.Pid } | ForEach-Object { [int]$_.ProcessId })
    passiveChildPids = @($all | Where-Object { $_.ParentProcessId -eq $held.Pid -and (Test-PassiveConsole $_) } | ForEach-Object { [int]$_.ProcessId })
    ancestors = @($ancestors)
   }
  } catch {
   # Still report inaccessible owners; incomplete identity never qualifies for cleanup.
   @{ pid = [int]$held.Pid; name = [string]$item.Name; executablePath = ''; commandLine = ''; startTimeTicks = ''; cpuSeconds = -1; ageSeconds = 0; sessionId = -1; hasWindow = $true; hasConnection = $true; paths = @($held.Paths); childPids = @(); ancestors = @() }
  } finally { if ($runtime) { $runtime.Dispose() } }
 })
 return @{ holders = @($holders); networkKnown = $networkKnown; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
}
$snapshot = Get-LockSnapshot
if ($env:AI_WRITER_LOCK_ACTION -eq 'release') {
 $codexRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex')).TrimEnd('\')
 function Test-CodexServer($item) {
  return $item -and $item.executablePath.StartsWith($codexRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and $item.executablePath.Substring($codexRoot.Length) -match '^\\bin\\[^\\]+\\codex\.exe$'
 }
 function Get-CodexRuntimeKind($item) {
  if (-not $item -or -not $item.executablePath.StartsWith($codexRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { return '' }
  if ($item.executablePath.Substring($codexRoot.Length) -notmatch '^\\runtimes\\cua_node\\[^\\]+\\bin\\(node_repl|node)\.exe$') { return '' }
  $kind = $Matches[1]
  if ($kind -eq 'node' -and $item.commandLine -notmatch '[\\/]@oai[\\/]cua-repl[\\/]bin[\\/]cua-repl\.mjs(?:"|\s|$)') { return '' }
  return $kind
 }
 $requested = @($env:AI_WRITER_LOCK_CANDIDATES | ConvertFrom-Json)
 $released = @()
 foreach ($candidate in $requested) {
  $fresh = @($snapshot.holders | Where-Object { $_.pid -eq $candidate.pid }) | Select-Object -First 1
  if (-not $snapshot.networkKnown -or -not $fresh) { continue }
  $kind = Get-CodexRuntimeKind $fresh
  $knownParent = (Test-CodexServer $fresh.ancestors[0]) -or ($kind -eq 'node_repl' -and (Get-CodexRuntimeKind $fresh.ancestors[0]) -eq 'node' -and (Test-CodexServer $fresh.ancestors[1]))
  if (-not $kind -or -not $knownParent -or $fresh.ageSeconds -lt 60 -or $fresh.startTimeTicks -ne $candidate.startTimeTicks -or $fresh.executablePath -ne $candidate.executablePath -or $fresh.cpuSeconds -lt 0 -or $fresh.cpuSeconds -gt $candidate.cpuSeconds -or $fresh.cpuSeconds -gt 0.25 -or $fresh.hasConnection -or $fresh.hasWindow -or $fresh.sessionId -ne $snapshot.sessionId -or $fresh.paths.Count -eq 0 -or @($fresh.paths | Where-Object { $_ -ne $directory }).Count -gt 0) { continue }
  if ((Get-CodexRuntimeKind $fresh.ancestors[0]) -eq 'node') {
   $parentRequest = @($requested | Where-Object { $_.pid -eq $fresh.ancestors[0].pid }) | Select-Object -First 1
   $parentFresh = @($snapshot.holders | Where-Object { $_.pid -eq $fresh.ancestors[0].pid }) | Select-Object -First 1
   if (-not $parentRequest -or -not $parentFresh -or $parentFresh.startTimeTicks -ne $parentRequest.startTimeTicks -or $parentFresh.cpuSeconds -gt $parentRequest.cpuSeconds -or $parentFresh.hasConnection -or $parentFresh.hasWindow) { continue }
   if (@($parentFresh.childPids | Where-Object { $parentFresh.passiveChildPids -notcontains $_ -and $requested.pid -notcontains $_ }).Count -gt 0) { continue }
  }
  $runtime = $null
  try {
   $runtime = [Diagnostics.Process]::GetProcessById([int]$candidate.pid)
   # Bind a process handle before validating, so PID reuse cannot target a replacement.
   $null = $runtime.Handle
   if ($runtime.StartTime.ToUniversalTime().Ticks.ToString() -ne $candidate.startTimeTicks -or $runtime.MainModule.FileName -ne $candidate.executablePath -or $runtime.MainWindowHandle -ne [IntPtr]::Zero -or $runtime.TotalProcessorTime.TotalSeconds -gt $candidate.cpuSeconds -or $runtime.TotalProcessorTime.TotalSeconds -gt 0.25) { continue }
   $childrenNow = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + [int]$candidate.pid))
   if (@($childrenNow | Where-Object { -not (Test-PassiveConsole $_) }).Count -gt 0) { continue }
   $runtime.Kill()
   if ($runtime.WaitForExit(1000)) { $released += [int]$candidate.pid }
  } catch { }
  finally { if ($runtime) { $runtime.Dispose() } }
 }
 @{ released = @($released) } | ConvertTo-Json -Depth 8 -Compress
} else {
 $snapshot | ConvertTo-Json -Depth 8 -Compress
}
`
