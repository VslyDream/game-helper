using System;
using System.Collections;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace GameHelper;

/// <summary>
/// Запуск процесса вне дерева процессов игры.
///
/// Steam отслеживает всех потомков игры («AppID … adding PID … as a tracked process», даже после выхода
/// из job object) и считает игру запущенной, пока они живы. Порядок попыток:
///   1. WMI Win32_Process.Create (через короткоживущий powershell): родитель — WmiPrvSE, Steam его не видит;
///   2. CreateProcessW с CREATE_BREAKAWAY_FROM_JOB (если job игры разрешает);
///   3. обычный дочерний процесс (Steam может ждать сервис перед «отпуском» игры).
///
/// Переменные DOORSTOP_* (Doorstop помечает ими процесс как внедрённый) из окружения потомка убираются:
/// иначе игра, запущенная потом из панели, стартует без BepInEx. WMI-процесс получает окружение
/// пользователя, а не игры, — там их и так нет.
/// </summary>
public static class DetachedProcess
{
    const uint CreateBreakawayFromJob = 0x01000000;
    const uint CreateNoWindow = 0x08000000;
    const uint CreateNewProcessGroup = 0x00000200;
    const uint CreateUnicodeEnvironment = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmdLine, IntPtr procAttr, IntPtr threadAttr,
        bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInformation pi);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    /// <returns>pid или 0; mode — каким способом (wmi | breakaway | child).</returns>
    public static int Start(string[] command, string workingDirectory, out string mode)
    {
        var line = string.Join(" ", command.Select(Quote));

        var pid = StartViaWmi(line, workingDirectory);
        if (pid > 0) { mode = "wmi"; return pid; }

        pid = StartBreakaway(line, workingDirectory);
        if (pid > 0) { mode = "breakaway"; return pid; }

        try
        {
            var psi = new ProcessStartInfo(command[0])
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            for (var i = 1; i < command.Length; i++) psi.ArgumentList.Add(command[i]);
            if (workingDirectory != null) psi.WorkingDirectory = workingDirectory;
            StripDoorstop(psi);
            using var p = Process.Start(psi);
            mode = "child (Steam может держать игру «запущенной», пока жив сервис)";
            return p?.Id ?? 0;
        }
        catch (Exception e)
        {
            Plugin.Warn("service start failed: " + e.Message);
            mode = "";
            return 0;
        }
    }

    /// <summary>powershell → Invoke-CimMethod Win32_Process.Create; отслеживаемый потомок — только этот powershell.</summary>
    static int StartViaWmi(string commandLine, string workingDirectory)
    {
        try
        {
            static string Ps(string s) => "'" + s.Replace("'", "''") + "'";
            var args = "@{CommandLine=" + Ps(commandLine) +
                       (string.IsNullOrEmpty(workingDirectory) ? "" : "; CurrentDirectory=" + Ps(workingDirectory)) + "}";
            var script = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments " + args +
                         "; if ($r.ReturnValue -eq 0) { [Console]::Out.Write($r.ProcessId) } else { [Console]::Out.Write('E' + $r.ReturnValue) }";
            var psi = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script })
                psi.ArgumentList.Add(a);
            StripDoorstop(psi);
            using var p = Process.Start(psi);
            if (p == null) return 0;
            var output = p.StandardOutput.ReadToEnd().Trim();
            var error = p.StandardError.ReadToEnd().Trim();
            if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { /* ignore */ } return 0; }
            if (int.TryParse(output, out var pid) && pid > 0) return pid;
            Plugin.Warn($"service start via WMI failed: '{output}' {error}");
            return 0;
        }
        catch (Exception e)
        {
            Plugin.Warn("service start via WMI failed: " + e.Message);
            return 0;
        }
    }

    static int StartBreakaway(string commandLine, string workingDirectory)
    {
        var env = BuildEnvironmentBlock();
        try
        {
            var si = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>() };
            var flags = CreateNoWindow | CreateNewProcessGroup | CreateUnicodeEnvironment | CreateBreakawayFromJob;
            if (CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, env,
                    workingDirectory, ref si, out var pi))
            {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                return pi.dwProcessId;
            }
            Plugin.Warn($"service breakaway start failed (win32 {Marshal.GetLastWin32Error()})");
            return 0;
        }
        finally
        {
            Marshal.FreeHGlobal(env);
        }
    }

    /// <summary>Окружение текущего процесса без DOORSTOP_*: "K=V\0K=V\0\0", UTF-16, отсортировано.</summary>
    static IntPtr BuildEnvironmentBlock()
    {
        var sb = new StringBuilder();
        var vars = Environment.GetEnvironmentVariables().Cast<DictionaryEntry>()
            .Select(e => (key: (string)e.Key, value: (string)e.Value))
            .Where(e => !IsDoorstop(e.key))
            .OrderBy(e => e.key, StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in vars) sb.Append(key).Append('=').Append(value).Append('\0');
        sb.Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }

    static void StripDoorstop(ProcessStartInfo psi)
    {
        foreach (var key in psi.Environment.Keys.ToList())
            if (IsDoorstop(key)) psi.Environment.Remove(key);
    }

    static bool IsDoorstop(string key) => key.StartsWith("DOORSTOP", StringComparison.OrdinalIgnoreCase);

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
        return "\"" + arg.Replace("\"", "\\\"") + "\"";
    }
}
