using System;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using HarmonyLib;

namespace GameHelper;

/// <summary>
/// Точка входа. ЗАМЕНИТЬ при создании проекта: пространство имён/сборку GameHelper, __GAME_ID__, порты.
///
/// ВАЖНО: в Load() нельзя трогать Unity API (Application, Time, GameObject, FindObjectsOfType...):
/// движок ещё не готов, это даёт зависание или падение без внятного лога. Вся работа с игрой —
/// на главном потоке через <see cref="Runner"/> (первый кадр, Post/Invoke/Start).
/// </summary>
[BepInPlugin(Guid, Name, Version)]
public sealed class Plugin : BasePlugin
{
    public const string Guid = "local.__GAME_ID__.helper";
    public const string Name = "GameHelper";
    public const string Version = "0.1.0";

    // CORE-18: у каждой игры свои порты, чтобы хелперы разных игр не конфликтовали.
    public const int DefaultApiPort = 18801;     // ЗАМЕНИТЬ: HttpListener плагина
    public const int DefaultServicePort = 18800; // ЗАМЕНИТЬ: локальный сервис панели (Python)

    internal static ManualLogSource L;
    internal static Plugin Instance;
    internal static Harmony HarmonyInstance;

    // ---- настройки (BepInEx\config\<Guid>.cfg; агент может править текстом при закрытой игре) ----
    internal static ConfigEntry<int> ApiPort;
    internal static ConfigEntry<string> AllowedOrigins;
    internal static ConfigEntry<bool> DevTools;
    internal static ConfigEntry<bool> ServiceAutostart;
    internal static ConfigEntry<string> ServiceCommand;
    internal static ConfigEntry<int> ServicePort;
    internal static ConfigEntry<string> MenuScenes;

    public override void Load()
    {
        L = Log;
        Instance = this;
        BindConfig();

        // Главный поток: очередь задач, долгие операции, runInBackground (CORE-19).
        // AddComponent<T> в BE сам регистрирует тип через ClassInjector.
        AddComponent<Runner>();

        // Перехваты ставим вручную через HookReport: каждый записан (найден ли метод, встал ли патч),
        // а недостающий отключает только зависимые читы (CORE-22). PatchAll падает целиком на первом
        // несовпадении после обновления игры, поэтому для [HarmonyPatch]-классов — только если нужно:
        //   HarmonyInstance.PatchAll(typeof(Plugin).Assembly);
        HarmonyInstance = new Harmony(Guid);
        try { Commands.InstallHooks(HarmonyInstance); }
        catch (Exception e) { Error("hooks: " + e); }

        Commands.RegisterAll();
        if (DevTools.Value) Inspect.Register(); // команды только для агента (inspect.*, log.tail)

        Api.Start(ApiPort.Value);
        HelperService.EnsureRunning();
        Info($"{Name} {Version} loaded; API http://127.0.0.1:{ApiPort.Value}/ devTools={DevTools.Value}");
    }

    public override bool Unload()
    {
        Api.Stop();
        try { HarmonyInstance?.UnpatchSelf(); } catch { /* игра закрывается */ }
        return base.Unload();
    }

    void BindConfig()
    {
        ApiPort = Config.Bind("Api", "Port", DefaultApiPort, "Порт HTTP API плагина (только 127.0.0.1).");
        AllowedOrigins = Config.Bind("Api", "AllowedOrigins",
            $"http://127.0.0.1:{DefaultServicePort},http://localhost:{DefaultServicePort}",
            "Через запятую: Origin страниц, которым можно менять состояние. Запросы без Origin (CLI, MCP) разрешены.");
        DevTools = Config.Bind("Dev", "DevTools", false,
            "Команды агента inspect.* и log.tail. Включать только на время исследования/отладки.");
        ServiceAutostart = Config.Bind("Service", "Autostart", false,
            "Запускать локальный сервис панели вместе с игрой, если он ещё не слушает порт.");
        ServiceCommand = Config.Bind("Service", "Command", "",
            "Командная строка сервиса, например: \"C:\\Python312\\pythonw.exe\" \"D:\\Helper\\service\\main.py\"");
        ServicePort = Config.Bind("Service", "Port", DefaultServicePort, "Порт сервиса панели (проверка «уже запущен»).");
        MenuScenes = Config.Bind("Game", "MenuScenes", "",
            "ЗАПОЛНИТЬ: имена сцен меню через запятую (см. лог 'scene:'). Остальные сцены считаются уровнем, пока State.Connection не заменён на точный признак.");
    }

    internal static void Info(string message) => L?.LogInfo(message);
    internal static void Warn(string message) => L?.LogWarning(message);
    internal static void Error(string message) => L?.LogError(message);
}
