# The caller verifies the pinned executable, protected configuration and activation policy.
# This host owns only its suspended child/job. It never reads a profile or credential.
param([string]$ExecutablePath, [string]$ProfilePath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ownedTunnel = $null
$failureCode = 'host_failed'
$childExitCode = $null

function Write-ControlLine([string]$Line) {
    [Console]::Out.WriteLine($Line)
    [Console]::Out.Flush()
}

function Get-HealthListeners {
    # Query failure is not evidence that the port is free. Query every listening
    # socket so Get-NetTCPConnection's "no matching object" error is unnecessary.
    @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq 3942 })
}

function Test-OwnedHealth([int]$ChildPid, [string]$Path) {
    $listeners = @(Get-HealthListeners)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $ChildPid -or $listeners[0].LocalAddress -ne '127.0.0.1') { return $false }
    # Disable proxies and redirects; neither response headers nor bodies enter diagnostics.
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:3942/$Path")
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $response = $null
    try {
        $response = $request.GetResponse()
        return ([int]$response.StatusCode -eq 200)
    } catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) { $_.Exception.Response.Dispose() }
        return $false
    } catch { return $false } finally { if ($null -ne $response) { $response.Dispose() } }
}

try {
    # No interpolated shell, command, environment, profile content or secret argument.
    $failureCode = 'invalid_path'
    foreach ($path in @($ExecutablePath, $ProfilePath)) {
        if ([string]::IsNullOrWhiteSpace($path) -or $path -notmatch '^[A-Za-z]:\\' -or $path.Contains([char]0) -or
            [IO.Path]::GetFullPath($path) -cne $path -or -not [IO.File]::Exists($path)) { $failureCode = 'invalid_path'; throw 'path' }
    }
    if ([IO.Path]::GetExtension($ExecutablePath) -ine '.exe') { $failureCode = 'invalid_executable'; throw 'executable' }
    $nativeSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class FoundryOwnedTunnel : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
        public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
        public int cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title;
        public uint x,y,xSize,ySize,xCount,yCount,fill,flags; public ushort show,reservedSize;
        public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetInformationJobObject(IntPtr job,int info,ref ExtendedLimit limit,uint length);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SecurityAttributes attributes,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr resultBytes);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref StartupInfoEx startup,out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
    IntPtr job,process; public uint Pid { get; private set; }
    public static bool VisibleConsole() { IntPtr window=GetConsoleWindow(); return window!=IntPtr.Zero && IsWindowVisible(window); }
    // Windows argv quoting, including trailing slashes before a closing quote.
    public static string QuoteArgument(string value) {
        if(value==null || value.IndexOf('\0')>=0) throw new InvalidOperationException("host_failed");
        StringBuilder result=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
            result.Append('\\',slashes); slashes=0; result.Append(c);
        }
        result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
    }
    public FoundryOwnedTunnel(string executable,string profile) {
        IntPtr nul=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero; bool attributesReady=false;
        ProcessInformation child=new ProcessInformation(); bool assigned=false;
        try {
            if(!VisibleConsole()) throw new InvalidOperationException("visible_console_required");
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new InvalidOperationException("job_create_failed");
            ExtendedLimit limits=new ExtendedLimit(); limits.Basic.Flags=0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new InvalidOperationException("job_limits_failed");
            SecurityAttributes security=new SecurityAttributes(); security.Length=Marshal.SizeOf(typeof(SecurityAttributes)); security.Inherit=true;
            nul=CreateFile("NUL",0xC0000000,3,ref security,3,0,IntPtr.Zero);
            if(nul==new IntPtr(-1)) throw new InvalidOperationException("nul_handle_failed");
            IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
            if(bytes==IntPtr.Zero) throw new InvalidOperationException("attribute_list_failed");
            attributes=Marshal.AllocHGlobal(bytes);
            if(!InitializeProcThreadAttributeList(attributes,1,0,ref bytes)) throw new InvalidOperationException("attribute_list_failed");
            attributesReady=true; handles=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles,nul);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: only NUL is inherited, never control pipes/job handles.
            if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020002),handles,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException("handle_list_failed");
            StartupInfoEx startup=new StartupInfoEx(); startup.Info.cb=Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Info.flags=0x00000100; startup.Info.input=nul; startup.Info.output=nul; startup.Info.error=nul;
            startup.Attributes=attributes;
            string command=QuoteArgument(executable)+" run --profile-file "+QuoteArgument(profile)+" --health.listen-addr 127.0.0.1:3942 --log.level info";
            // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT; inherit the visible console.
            if(!CreateProcessW(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x00080004,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out child)) throw new InvalidOperationException("process_create_failed");
            if(!AssignProcessToJobObject(job,child.Process)) throw new InvalidOperationException("job_assign_failed");
            assigned=true;
            if(ResumeThread(child.Thread)==0xFFFFFFFF) throw new InvalidOperationException("process_resume_failed");
            process=child.Process; child.Process=IntPtr.Zero; Pid=child.Pid;
        } catch {
            // Assignment failure still owns an exact suspended process; it cannot escape/run.
            if(child.Process!=IntPtr.Zero && !assigned) TerminateProcess(child.Process,1);
            Dispose(); throw;
        } finally {
            if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread);
            if(child.Process!=IntPtr.Zero) CloseHandle(child.Process);
            if(attributesReady) DeleteProcThreadAttributeList(attributes);
            if(attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if(nul!=IntPtr.Zero && nul!=new IntPtr(-1)) CloseHandle(nul);
        }
    }
    public bool Alive() { uint code; return process!=IntPtr.Zero && WaitForSingleObject(process,0)==258 && GetExitCodeProcess(process,out code) && code==259; }
    public uint? ExitCode() { uint code; return process!=IntPtr.Zero && WaitForSingleObject(process,0)==0 && GetExitCodeProcess(process,out code) ? (uint?)code : null; }
    public void Dispose() {
        if(job!=IntPtr.Zero) { TerminateJobObject(job,0); CloseHandle(job); job=IntPtr.Zero; }
        if(process!=IntPtr.Zero) { WaitForSingleObject(process,5000); CloseHandle(process); process=IntPtr.Zero; }
    }
}
'@
    $failureCode = 'native_compile_failed'
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop
    if (-not [FoundryOwnedTunnel]::VisibleConsole()) { $failureCode = 'visible_console_required'; throw 'visibility' }
    $failureCode = 'health_listener_failed'
    if (@(Get-HealthListeners).Count -ne 0) { $failureCode = 'health_port_occupied'; throw 'port' }
    $failureCode = 'host_failed'
    $ownedTunnel = [FoundryOwnedTunnel]::new($ExecutablePath, $ProfilePath)
    [Console]::Error.WriteLine('Foundry OpenAI tunnel: owned child started in this visible console.')
    Write-ControlLine ('{"kind":"started","pid":' + $ownedTunnel.Pid + '}')
    while ($true) {
        # Read exactly a bounded named control. ReadLine would allocate unbounded input.
        $failureCode = 'control_input_invalid'
        $control = [Text.StringBuilder]::new()
        $carriageReturn = $false
        while ($true) {
            $character = [Console]::In.Read()
            if ($character -eq -1 -or $character -eq 10) { break }
            if ($carriageReturn) { throw 'invalid_control' }
            if ($character -eq 13) { $carriageReturn = $true } else { [void]$control.Append([char]$character) }
            if ($control.Length -gt 6) { throw 'invalid_control' }
        }
        if ($character -eq -1 -or $control.ToString() -ceq 'stop') { break }
        if (-not [FoundryOwnedTunnel]::VisibleConsole()) { $failureCode = 'visible_console_required'; throw 'visibility' }
        if ($control.ToString() -cne 'status') { throw 'invalid_control' }
        if (-not $ownedTunnel.Alive()) { $failureCode = 'child_exited'; $childExitCode = $ownedTunnel.ExitCode(); throw 'child' }
        $failureCode = 'health_listener_failed'
        $healthy = Test-OwnedHealth ([int]$ownedTunnel.Pid) 'healthz'
        $ready = Test-OwnedHealth ([int]$ownedTunnel.Pid) 'readyz'
        Write-ControlLine ('{"kind":"health","healthy":' + $healthy.ToString().ToLowerInvariant() + ',"ready":' + $ready.ToString().ToLowerInvariant() + '}')
    }
    $ownedTunnel.Dispose()
    $ownedTunnel = $null
    [Console]::Error.WriteLine('Foundry OpenAI tunnel: owned child stopped.')
    Write-ControlLine '{"kind":"stopped"}'
} catch {
    # Only exact fixed stage literals may cross the private control pipe. Method
    # invocation wrappers carry native stage codes in their inner exception.
    $nativeCodes = @('visible_console_required','job_create_failed','job_limits_failed','nul_handle_failed',
        'attribute_list_failed','handle_list_failed','process_create_failed','job_assign_failed','process_resume_failed')
    $exception = $_.Exception
    for ($depth = 0; $null -ne $exception -and $depth -lt 8; $depth++) {
        if ($nativeCodes -ccontains $exception.Message) { $failureCode = $exception.Message; break }
        $exception = $exception.InnerException
    }
    # Never print exception text, HTTP bodies, client output or configuration values.
    [Console]::Error.WriteLine('Foundry OpenAI tunnel: activation host refused or stopped.')
    $exitCodeJson = if ($null -eq $childExitCode) { 'null' } else { ([uint32]$childExitCode).ToString([Globalization.CultureInfo]::InvariantCulture) }
    Write-ControlLine ('{"kind":"failed","code":"' + $failureCode + '","exitCode":' + $exitCodeJson + '}')
    exit 1
} finally { if ($null -ne $ownedTunnel) { $ownedTunnel.Dispose() } }
