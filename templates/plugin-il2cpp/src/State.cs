using System;
using System.Linq;
using System.Text.Json.Nodes;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GameHelper;

/// <summary>
/// GET /api/state (contracts/adapter.md): connection, gameRunning, role, operation, availability, модули.
/// Плюс слежение за сменой уровня: вход — повторное применение читов (CORE-17) и самопроверка (CORE-22),
/// выход — откат читов и Time.timeScale = 1.
/// </summary>
public static class State
{
    static readonly object Sync = new();
    static JsonObject operation;
    static string lastConnection = "";
    static string lastScene = "";
    static float nextCheck;

    /// <summary>Последнее вычисленное значение connection (обновляется каждые 0,25 с на главном потоке).</summary>
    public static volatile string CurrentConnection = "waiting";

    // ------------------------------------------------------------------ операция

    /// <summary>Долгая операция (загрузка, снимок): видна в строке статуса панели, завершение — в следующих статусах.</summary>
    public static void SetOperation(string id, string stage, string message)
    {
        lock (Sync) operation = new JsonObject { ["id"] = id, ["stage"] = stage, ["message"] = message };
    }

    public static void ClearOperation()
    {
        lock (Sync) operation = null;
    }

    public static JsonNode OperationCopy()
    {
        lock (Sync) return operation?.Copy();
    }

    // ------------------------------------------------------------------ подключение

    /// <summary>
    /// ЗАПОЛНИТЬ под игру: menu | level | waiting. Заготовка — по имени сцены и [Game] MenuScenes в конфиге.
    /// Лучше заменить точным признаком «мир готов» (захваченный в Harmony-postfix менеджер уровня,
    /// заспавненный игрок): иначе читы применяются, пока уровень ещё грузится.
    /// </summary>
    static string ComputeConnection()
    {
        var scene = SceneName;
        if (string.IsNullOrEmpty(scene)) return "waiting";
        var menus = Plugin.MenuScenes.Value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (menus.Contains(scene, StringComparer.OrdinalIgnoreCase)) return "menu";
        return "level";
    }

    public static string SceneName
    {
        get
        {
            try { return SceneManager.GetActiveScene().name ?? ""; }
            catch { return ""; }
        }
    }

    /// <summary>ЗАПОЛНИТЬ для сетевой игры: solo | host | client (читы хоста недоступны клиенту).</summary>
    static string Role() => "solo";

    /// <summary>Подписка на кадры Runner. Вызывается из Commands.RegisterAll.</summary>
    public static void Init() => Runner.OnFrame += Tick;

    static void Tick()
    {
        var scene = SceneName;
        if (scene != lastScene)
        {
            Plugin.Info($"scene: '{lastScene}' -> '{scene}'");
            lastScene = scene;
            Application.runInBackground = true;
        }

        var now = Time.unscaledTime;
        if (now < nextCheck) return;
        nextCheck = now + 0.25f;
        var connection = ComputeConnection();
        if (connection == lastConnection) return;

        var previous = lastConnection;
        lastConnection = connection;
        CurrentConnection = connection;
        HookReport.Invalidate();
        Plugin.Info($"connection: {previous} -> {connection} (scene={scene})");

        if (previous == "level") Cheats.OnLeaveLevel();
        if (connection == "level")
        {
            HookReport.LogSummary("level");
            Cheats.OnEnterLevel();
        }
    }

    // ------------------------------------------------------------------ сборка

    /// <summary>Только главный поток (из HTTP — через Runner.Invoke).</summary>
    public static JsonObject Build()
    {
        var state = new JsonObject
        {
            ["connection"] = CurrentConnection,
            ["gameRunning"] = true,
            ["role"] = Role(),
            ["operation"] = OperationCopy(),
            ["version"] = Plugin.Version,
            ["scene"] = SceneName,
            ["focused"] = Application.isFocused,
            // MCP-05: пауза и скорость видны всегда, чтобы «стоит на паузе» не путали с «зависла».
            ["paused"] = Time.timeScale <= 0f,
            ["timeScale"] = Math.Round(Time.timeScale, 3),
            ["frame"] = Time.frameCount,
        };

        void Section(string key, Func<JsonNode> build)
        {
            try { state[key] = build(); }
            catch (Exception e) { Plugin.Warn($"state.{key}: {e.Message}"); }
        }

        Section("hooks", HookReport.Build);
        Section("cheats", Cheats.StateJson);
        Section("settings", () => new JsonObject
        {
            ["gamePath"] = BepInEx.Paths.GameRootPath,
            ["dataPath"] = Application.persistentDataPath,
        });
        // ЗАПОЛНИТЬ: секции выбранных модулей (freecam, snapshots, ...) — только выбранных (контракт).

        var availability = Api.Availability();
        availability["game.launch"] = Api.Available("Игра уже запущена");
        foreach (var (key, value) in Cheats.Availability()) availability[key] = value;
        state["availability"] = availability;
        return state;
    }
}
