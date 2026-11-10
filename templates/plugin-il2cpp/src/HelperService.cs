using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace GameHelper;

/// <summary>
/// Поднимает локальный сервис панели (Python, без окна), когда игра стартует с модом, — панель доступна
/// без отдельного запуска (CORE-02/CORE-18). Только если [Service] Autostart=true и порт ещё не слушается.
/// Процесс запускается ВНЕ дерева процессов игры (<see cref="DetachedProcess"/>): иначе Steam считает
/// сервис частью игры и держит её «запущенной» после выхода (повторный запуск: «игра уже запущена»).
/// Без Unity API — работает в фоновом потоке прямо из Load.
/// </summary>
public static class HelperService
{
    public static void EnsureRunning()
    {
        if (!Plugin.ServiceAutostart.Value)
        {
            Plugin.Info("service autostart is off ([Service] Autostart=false)");
            return;
        }
        new Thread(() =>
        {
            try { StartIfNeeded(); }
            catch (Exception e) { Plugin.Warn("service autostart failed: " + e.Message); }
        }) { IsBackground = true, Name = Plugin.Name + ".ServiceStart" }.Start();
    }

    static void StartIfNeeded()
    {
        var port = Plugin.ServicePort.Value;
        if (PortOpen(port))
        {
            Plugin.Info($"service already listens on {port}");
            return;
        }
        var command = SplitCommandLine(Plugin.ServiceCommand.Value);
        if (command.Count == 0)
        {
            Plugin.Warn("[Service] Command is empty, cannot start the service");
            return;
        }
        // Рабочая папка — папка скрипта (второй аргумент), иначе папка программы.
        var script = command.Count > 1 ? command[1] : command[0];
        string dir = null;
        try { dir = Path.GetDirectoryName(script); } catch { /* не путь */ }
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) dir = null;

        var pid = DetachedProcess.Start(command.ToArray(), dir, out var mode);
        Plugin.Info(pid > 0
            ? $"service started: pid={pid} mode={mode}"
            : "service was not started (see warnings above)");
    }

    public static bool PortOpen(int port)
    {
        try
        {
            using var client = new TcpClient();
            return client.ConnectAsync("127.0.0.1", port).Wait(300) && client.Connected;
        }
        catch { return false; }
    }

    /// <summary>Разбор командной строки Windows: пробелы разделяют, "..." объединяют.</summary>
    public static List<string> SplitCommandLine(string line)
    {
        var result = new List<string>();
        if (string.IsNullOrWhiteSpace(line)) return result;
        var current = new StringBuilder();
        bool quoted = false, any = false;
        foreach (var ch in line)
        {
            if (ch == '"') { quoted = !quoted; any = true; continue; }
            if (char.IsWhiteSpace(ch) && !quoted)
            {
                if (any) result.Add(current.ToString());
                current.Clear();
                any = false;
                continue;
            }
            current.Append(ch);
            any = true;
        }
        if (any) result.Add(current.ToString());
        return result;
    }
}
