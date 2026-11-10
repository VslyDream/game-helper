using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace GameHelper;

/// <summary>
/// Регистрация команд и перехватов. Здесь — общие команды основы и образцы читов;
/// конкретные читы игры добавляются по тому же образцу (по файлу на группу, если их много).
/// </summary>
public static class Commands
{
    /// <summary>Harmony-перехваты (из Plugin.Load: Unity API здесь ещё нельзя, Harmony — можно).</summary>
    public static void InstallHooks(Harmony harmony)
    {
        // ЗАПОЛНИТЬ. Ключ — «Класс.Метод», его же указывают в Cheat.Hooks зависимых читов:
        // HookReport.Patch(harmony, "Health.TakeDamage", typeof(Health), "TakeDamage", null,
        //     typeof(ExamplePatches), prefix: nameof(ExamplePatches.TakeDamagePrefix));
        //
        // Живая проверка на уровне (объект есть, id из пресета существует):
        // HookReport.Expect("PlayerController", () => Object.FindObjectOfType<PlayerController>() != null, "Игрок не найден");
    }

    public static void RegisterAll()
    {
        State.Init();
        Runner.OnFirstFrame += Cheats.OnFirstFrame;

        Api.Register("game.close", _ =>
        {
            Runner.Start(QuitSoon());
            return null;
        }, info: new CommandInfo("Закрыть игру", "выйти из игры", "закрой игру"));

        Api.Register("cheat.set", Cheats.Set);
        Api.Register("cheat.run", Cheats.Run);

        // ---- образцы (удалить/заменить под игру) ----
        Cheats.Add(new Cheat
        {
            Id = "exampleToggle",
            Title = "Пример переключателя",
            Aliases = new[] { "пример" },
            Kind = "toggle",
            Default = false,
            RequiresLevel = true,
            Hooks = Array.Empty<string>(), // например { "Health.TakeDamage" }
            Apply = v => Plugin.Info("exampleToggle = " + Json.Bool(v)),
            Revert = () => Plugin.Info("exampleToggle reverted"),
        });
        TimeControl.Register();
    }

    /// <summary>Ответ на game.close успевает уйти до выхода.</summary>
    static IEnumerator QuitSoon()
    {
        yield return new Wait(0.3f);
        Plugin.Info("Application.Quit()");
        Application.Quit();
    }
}

// Образец патча. Тип игры берётся из interop (Assembly-CSharp); имя чита проверяется в самом патче:
// static class ExamplePatches
// {
//     // return false в prefix — оригинал не вызывается. Помнить CORE-21: если чит пропускает событие,
//     // игра должна получить тот же сигнал, что при штатном завершении.
//     public static bool TakeDamagePrefix(Health __instance) => !(Cheats.IsOn("godMode") && __instance.IsPlayer);
// }

/// <summary>Описание чита: формат совпадает с config.json → cheats (id, type), поведение — здесь.</summary>
public sealed class Cheat
{
    public string Id;
    public string Title;
    public string[] Aliases = Array.Empty<string>();
    /// <summary>toggle | range | select | action</summary>
    public string Kind = "toggle";
    public JsonNode Default = false;
    /// <summary>Ключи HookReport; если какой-то не в порядке — чит отключён с причиной (CORE-22).</summary>
    public string[] Hooks = Array.Empty<string>();
    /// <summary>Применять только на уровне; при выходе — Revert, при входе — повторное применение.</summary>
    public bool RequiresLevel = true;
    /// <summary>CORE-17: запоминать между запусками. Пауза/×0/заморозка — Persist=false или OnRestore.</summary>
    public bool Persist = true;
    /// <summary>Значение после перезапуска: вернуть null — взять Default (например скорость 0 → обычная).</summary>
    public Func<JsonNode, JsonNode> OnRestore;
    /// <summary>Дополнительное условие доступности: причина или null.</summary>
    public Func<string> Unavailable;
    /// <summary>Главный поток: применить значение (toggle/range/select). Бросить GameException — отказ с причиной.</summary>
    public Action<JsonNode> Apply;
    /// <summary>Главный поток: вернуть игру в штатное состояние (выход с уровня, выключение).</summary>
    public Action Revert;
    /// <summary>Главный поток: разовое действие (Kind=action), values — из cheat.run.</summary>
    public Func<JsonObject, JsonObject> Run;
    /// <summary>Описание аргументов для /api/commands, по умолчанию выводится из Kind.</summary>
    public JsonObject Args;

    internal JsonNode Value;
    internal ConfigEntry<string> Saved;
}

public static class Cheats
{
    static readonly Dictionary<string, Cheat> All = new();
    static readonly List<string> Order = new();

    public static void Add(Cheat c)
    {
        if (c.Kind != "action")
        {
            c.Value = c.Default.Copy();
            if (c.Persist)
            {
                c.Saved = Plugin.Instance.Config.Bind("Cheats", c.Id, "", $"{c.Title}: сохранённое значение (JSON). Пусто — по умолчанию.");
                var restored = Parse(c.Saved.Value);
                if (restored != null && c.OnRestore != null) restored = c.OnRestore(restored);
                if (restored != null) c.Value = restored;
            }
        }
        lock (All)
        {
            if (!All.ContainsKey(c.Id)) Order.Add(c.Id);
            All[c.Id] = c;
        }
    }

    public static bool IsOn(string id) => Get(id) is { } c && c.Value != null && Json.Bool(c.Value);

    public static double Number(string id, double fallback = 0) => Get(id) is { } c && c.Value != null ? Json.Num(c.Value, fallback) : fallback;

    public static Cheat Get(string id)
    {
        lock (All) return All.TryGetValue(id, out var c) ? c : null;
    }

    static IEnumerable<Cheat> List()
    {
        lock (All) return Order.Select(id => All[id]).ToArray();
    }

    static Cheat Require(JsonObject args)
    {
        var id = args.Str("id") ?? throw new GameException("Не указан id чита");
        return Get(id) ?? throw new GameException("Нет такого чита: " + id);
    }

    /// <summary>Причина недоступности или null (главный поток).</summary>
    public static string Reason(Cheat c)
    {
        var reason = HookReport.Reason(c.Hooks);
        if (reason != null) return reason;
        if (c.RequiresLevel && State.CurrentConnection != "level") return "Доступно на уровне";
        return c.Unavailable?.Invoke();
    }

    /// <summary>cheat.set {id, value}</summary>
    public static JsonObject Set(JsonObject args)
    {
        var c = Require(args);
        if (c.Kind == "action") throw new GameException("Это разовое действие: cheat.run");
        var reason = Reason(c);
        if (reason != null) throw new GameException(reason);
        var value = args["value"].Copy() ?? throw new GameException("Не указано значение");
        c.Apply?.Invoke(value);           // при ошибке значение не меняется и не сохраняется
        c.Value = value;
        if (c.Saved != null) c.Saved.Value = value.ToJsonString(); // ConfigFile сохраняется сам
        return null;
    }

    /// <summary>cheat.run {id, values}</summary>
    public static JsonObject Run(JsonObject args)
    {
        var c = Require(args);
        if (c.Kind != "action" || c.Run == null) throw new GameException("Это переключатель: cheat.set");
        var reason = Reason(c);
        if (reason != null) throw new GameException(reason);
        return c.Run(args["values"] as JsonObject ?? new JsonObject());
    }

    // ---- жизненный цикл (главный поток, из State.Tick / Runner) ----

    /// <summary>Глобальные читы (RequiresLevel=false) — сразу, как Unity готов.</summary>
    public static void OnFirstFrame()
    {
        foreach (var c in List().Where(c => !c.RequiresLevel)) Reapply(c);
    }

    /// <summary>CORE-17: включённые режимы снова действуют после перезапуска игры/уровня.</summary>
    public static void OnEnterLevel()
    {
        foreach (var c in List().Where(c => c.RequiresLevel)) Reapply(c);
    }

    public static void OnLeaveLevel()
    {
        foreach (var c in List().Where(c => c.RequiresLevel && c.Kind != "action"))
        {
            if (!IsDefault(c)) TryRun(c, "revert", () => c.Revert?.Invoke());
            if (!c.Persist) c.Value = c.Default.Copy(); // пауза не переживает уход с уровня
        }
        // Страховка: игра не должна остаться остановленной (см. CORE-17).
        if (Time.timeScale <= 0f) Time.timeScale = 1f;
    }

    static void Reapply(Cheat c)
    {
        if (c.Kind == "action" || c.Apply == null || IsDefault(c)) return;
        var reason = HookReport.Reason(c.Hooks) ?? c.Unavailable?.Invoke();
        if (reason != null)
        {
            Plugin.Warn($"cheat {c.Id}: not reapplied: {reason}");
            return;
        }
        TryRun(c, "reapply", () => c.Apply(c.Value.Copy()));
    }

    static void TryRun(Cheat c, string what, Action action)
    {
        try { action(); Plugin.Info($"cheat {c.Id}: {what} {c.Value?.ToJsonString()}"); }
        catch (Exception e) { Plugin.Warn($"cheat {c.Id}: {what} failed: {e.Message}"); }
    }

    static bool IsDefault(Cheat c) => (c.Value?.ToJsonString() ?? "null") == (c.Default?.ToJsonString() ?? "null");

    static JsonNode Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try { return JsonNode.Parse(text); }
        catch { return null; }
    }

    // ---- для state и /api/commands ----

    public static JsonObject StateJson()
    {
        var result = new JsonObject();
        foreach (var c in List().Where(c => c.Kind != "action")) result[c.Id] = c.Value.Copy();
        return result;
    }

    public static IEnumerable<KeyValuePair<string, JsonNode>> Availability()
    {
        foreach (var c in List())
        {
            string reason;
            try { reason = Reason(c); }
            catch (Exception e) { reason = e.Message; }
            yield return new KeyValuePair<string, JsonNode>("cheat:" + c.Id, Api.Available(reason));
        }
    }

    public static IEnumerable<JsonObject> CommandList()
    {
        foreach (var c in List())
        {
            var args = c.Args?.Copy() ?? (c.Kind switch
            {
                "toggle" => new JsonObject { ["value"] = "boolean" },
                "range" => new JsonObject { ["value"] = "number" },
                "select" => new JsonObject { ["value"] = "string" },
                _ => new JsonObject { ["values"] = "object" },
            });
            yield return new JsonObject
            {
                ["command"] = c.Kind == "action" ? "cheat.run" : "cheat.set",
                ["id"] = c.Id,
                ["title"] = c.Title ?? c.Id,
                ["aliases"] = new JsonArray(c.Aliases.Select(a => (JsonNode)a).ToArray()),
                ["args"] = args,
            };
        }
    }
}

/// <summary>
/// Образец пары «пауза + скорость» на Time.timeScale — работает в большинстве Unity-игр.
/// Пауза не запоминается; скорость запоминается, но 0 после перезапуска становится 1 (CORE-17).
/// [I] проверить: если игра сама управляет timeScale (своё меню паузы, slow-mo), перехватывать её менеджер времени.
/// </summary>
public static class TimeControl
{
    public static void Register()
    {
        Cheats.Add(new Cheat
        {
            Id = "pause", Title = "Пауза", Aliases = new[] { "стоп", "заморозь время", "останови игру" },
            Kind = "toggle", Default = false, Persist = false,
            Apply = v => Time.timeScale = Json.Bool(v) ? 0f : (float)Math.Clamp(Cheats.Number("speed", 1), 0, 10),
            Revert = () => Time.timeScale = 1f,
        });
        Cheats.Add(new Cheat
        {
            Id = "speed", Title = "Скорость игры", Aliases = new[] { "ускорь", "замедли", "скорость времени" },
            Kind = "range", Default = 1.0,
            OnRestore = v => Json.Num(v, 1) <= 0.01 ? null : v,
            Apply = v => { if (!Cheats.IsOn("pause")) Time.timeScale = (float)Math.Clamp(Json.Num(v, 1), 0, 10); },
            Revert = () => Time.timeScale = 1f,
        });
    }
}
