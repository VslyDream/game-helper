using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json.Nodes;
using HarmonyLib;

namespace GameHelper;

/// <summary>
/// CORE-22: самопроверка. Каждый перехват ставится через <see cref="Patch"/> и записывается:
/// метод найден? патч встал (Harmony.GetPatchInfo)? Дополнительные живые проверки (<see cref="Expect"/>)
/// выполняются на уровне: найден ли нужный объект/синглтон, существуют ли id из пресетов и справочников.
/// Проблема отключает только читы, у которых этот ключ в зависимостях (Cheat.Hooks), с понятной причиной.
///
/// Правила IL2CPP (references/engines/unity-il2cpp-bepinex6.md):
///  - мелкие геттеры инлайнятся — патчить вызывающий метод;
///  - общие пустые заглушки (один RVA на много методов) патчить нельзя — сработает везде;
///  - generic-методы/классы патчатся плохо;
///  - быстрые перехваты не делают сканирований и работы с файлами.
/// </summary>
public static class HookReport
{
    sealed class Hook
    {
        public bool Found;
        public bool Installed;
        public string Note;
    }

    static readonly Dictionary<string, Hook> Hooks = new();
    static readonly Dictionary<string, (Func<bool> check, string reason)> Live = new();
    static readonly Dictionary<string, (bool ok, float until)> Cache = new();

    /// <summary>
    /// Поставить Harmony-патч и записать результат. key — устойчивое имя «Класс.Метод» для журнала и зависимостей.
    /// parameters = null → метод ищется по имени (если перегрузок несколько — передать типы).
    /// patchClass.prefix/postfix — статические методы с обычными аргументами Harmony (__instance, __result, ___field).
    /// </summary>
    public static bool Patch(Harmony harmony, string key, Type type, string method, Type[] parameters,
        Type patchClass, string prefix = null, string postfix = null)
    {
        var hook = new Hook();
        lock (Hooks) Hooks[key] = hook;
        try
        {
            var target = type == null ? null : AccessTools.Method(type, method, parameters);
            if (target == null)
            {
                hook.Note = "метод не найден";
                Plugin.Warn($"hook {key}: method not found");
                return false;
            }
            hook.Found = true;
            harmony.Patch(target,
                prefix: prefix == null ? null : new HarmonyMethod(AccessTools.Method(patchClass, prefix)),
                postfix: postfix == null ? null : new HarmonyMethod(AccessTools.Method(patchClass, postfix)));
            var info = Harmony.GetPatchInfo(target);
            hook.Installed = info != null && (info.Prefixes.Any(p => p.owner == harmony.Id) || info.Postfixes.Any(p => p.owner == harmony.Id));
            if (!hook.Installed) hook.Note = "патч не встал";
            Plugin.Info($"hook {key}: {(hook.Installed ? "installed" : "missing")}");
            return hook.Installed;
        }
        catch (Exception e)
        {
            hook.Note = "ошибка установки";
            Plugin.Error($"hook {key} failed: {e}");
            return false;
        }
    }

    /// <summary>
    /// Живая проверка, выполняется на уровне (connection == level), на главном потоке, кешируется 2 с.
    /// Пример: Expect("Player.Instance", () => FindPlayer() != null, "Игрок не найден").
    /// Вне уровня считается пройденной (объектов ещё нет).
    /// </summary>
    public static void Expect(string key, Func<bool> check, string reason = null)
    {
        lock (Live) Live[key] = (check, reason);
    }

    /// <summary>Сброс кеша — при смене connection/сцены (State.Tick).</summary>
    public static void Invalidate()
    {
        lock (Cache) Cache.Clear();
    }

    /// <summary>Ключ в порядке (главный поток).</summary>
    public static bool Ok(string key) => Problem(key) == null;

    /// <summary>Причина проблемы ключа или null.</summary>
    public static string Problem(string key)
    {
        Hook hook;
        lock (Hooks) Hooks.TryGetValue(key, out hook);
        if (hook != null && !hook.Installed) return $"{key}: {hook.Note}";

        (Func<bool> check, string reason) live;
        bool hasLive;
        lock (Live) hasLive = Live.TryGetValue(key, out live);
        if (!hasLive) return hook == null ? $"{key}: не зарегистрирован" : null;
        if (State.CurrentConnection != "level") return null;

        var now = UnityEngine.Time.realtimeSinceStartup;
        lock (Cache)
            if (Cache.TryGetValue(key, out var c) && now < c.until)
                return c.ok ? null : live.reason ?? $"{key}: не найдено в игре";
        bool ok;
        try { ok = live.check(); }
        catch { ok = false; }
        lock (Cache) Cache[key] = (ok, now + 2f);
        return ok ? null : live.reason ?? $"{key}: не найдено в игре";
    }

    /// <summary>Причина недоступности чита по его зависимостям или null (для availability "cheat:&lt;id&gt;").</summary>
    public static string Reason(IEnumerable<string> keys)
    {
        if (keys == null) return null;
        foreach (var key in keys)
        {
            var problem = Problem(key);
            if (problem != null) return "Не работает в этой версии игры (" + problem + ")";
        }
        return null;
    }

    /// <summary>state.hooks: {key: true|false} — для журнала, CLI и агента.</summary>
    public static JsonObject Build()
    {
        string[] keys;
        lock (Hooks) lock (Live) keys = Hooks.Keys.Concat(Live.Keys).Distinct().OrderBy(k => k, StringComparer.Ordinal).ToArray();
        var result = new JsonObject();
        foreach (var key in keys)
        {
            string problem;
            try { problem = Problem(key); }
            catch (Exception e) { problem = e.Message; }
            result[key] = problem == null;
        }
        return result;
    }

    /// <summary>Одна строка в журнал при входе на уровень: видно, что сломалось после обновления игры.</summary>
    public static void LogSummary(string when)
    {
        var report = Build();
        var bad = report.Where(kv => kv.Value is JsonValue v && v.TryGetValue<bool>(out var ok) && !ok).Select(kv => kv.Key).ToArray();
        if (bad.Length == 0) Plugin.Info($"self-check ({when}): {report.Count} ok");
        else Plugin.Warn($"self-check ({when}): problems: {string.Join(", ", bad)}");
    }
}
