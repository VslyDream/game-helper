# HarmonyX: шпаргалка

HarmonyX идёт в составе BepInEx 5 и 6 (`0Harmony.dll`). В IL2CPP патч ставится на нативный метод через interop-обёртку; в Mono — на IL. [V] — использовано в наших проектах, [I] — документация/вывод.

## 1. Два способа поставить патч

**Атрибуты + `PatchAll`** — коротко, но при отсутствии метода падает весь `PatchAll`, и не видно, что поставилось [V IronFrontier].

```csharp
[HarmonyPatch(typeof(Health), nameof(Health.DoDamage))]
static class GodMode {
    static bool Prefix(Health __instance, ref float damage) { ... }
}
new Harmony(Guid).PatchAll(typeof(Plugin).Assembly);
```

**Вручную с проверкой** — рекомендуемо: каждый патч отдельно, результат в `HookReport` (CORE-22) [V FBS].

```csharp
static void Patch(Harmony h, string key, Type type, string name, string prefix = null, string postfix = null, Type[] args = null) {
    try {
        var target = AccessTools.Method(type, name, args);
        if (target == null) { Installed[key] = false; Log.LogWarning($"hook {key}: method not found"); return; }
        h.Patch(target,
            prefix:  prefix  == null ? null : new HarmonyMethod(typeof(Hooks), prefix),
            postfix: postfix == null ? null : new HarmonyMethod(typeof(Hooks), postfix));
        Installed[key] = Harmony.GetPatchInfo(target) != null;
        Log.LogInfo($"hook {key}: {(Installed[key] ? "installed" : "missing")}");
    } catch (Exception e) { Installed[key] = false; Log.LogError($"hook {key}: {e}"); }
}
```

Методы-патчи при ручной установке могут быть `private static` — Harmony найдёт по имени через `HarmonyMethod(type, name)`.

## 2. Специальные параметры

| Параметр | Что | Примечание |
|---|---|---|
| `__instance` | объект, чей метод вызван | тип — interop-класс игры [V] |
| `__result` | возвращаемое значение | в postfix; `ref` — чтобы заменить [V] |
| `__state` | данные из prefix в postfix | тип любой; в prefix — `out` [I] |
| `__args` | `object[]` всех аргументов | [I] |
| `__originalMethod` | `MethodBase` оригинала | общий патч на несколько методов [I] |
| имя аргумента | аргумент оригинала по имени | `ref` — чтобы изменить [V] |
| `___field` | приватное поле экземпляра | Mono [I]; в IL2CPP поля — свойства interop, брать `__instance.field` [I] |

Имена аргументов должны совпадать с оригиналом (смотреть в interop/декомпиляции), иначе патч не встанет.

## 3. Prefix

```csharp
static bool Prefix() => !SkipTutorial;                    // false — оригинал не вызывается [V]

static bool Prefix(Health __instance, ref float damage) { // изменить аргумент
    try {
        if (damage >= 1e7f) return true;                  // скриптовые убийства проходят [V IronFrontier]
        if (IsPlayerSide(__instance)) { if (God) return false; damage /= Toughness; }
        return true;
    } catch (Exception e) { Log.LogError(e); return true; } // ошибка — оригинал работает
}

static bool Prefix(ref int __result) { __result = 0; return false; } // подменить результат без оригинала
```

`return false` пропускает оригинал, postfix'ы всё равно выполняются; судьба чужих prefix'ов зависит от версии Harmony — не полагаться, в своих смотреть `bool __runOriginal` [I]. Пропуская метод, помнить CORE-21: игра может ждать его последствий.

## 4. Postfix

```csharp
static void Postfix(ServerTimeService __instance) => TimeService = __instance;   // захват сервиса [V FBS]

static void Postfix(SquadConfig squad, int unitIndex, ref int __result) =>        // изменить результат [V IronFrontier]
    __result = Mathf.Max(1, Mathf.RoundToInt(__result * Multiplier));

static void Postfix(Il2CppSystem.Collections.Generic.List<Perk> __result) { ... } // IL2CPP-коллекция [V IronFrontier]
```

## 5. Finalizer

```csharp
static Exception Finalizer(Exception __exception) {   // вызывается всегда; null — проглотить исключение
    if (__exception != null) Log.LogWarning(__exception.Message);
    return null;
}
```

Глушить исключения игры — только осознанно и точечно [I].

## 6. Перегрузки, свойства, конструкторы

```csharp
[HarmonyPatch(typeof(Spawner), nameof(Spawner.Spawn), new[] { typeof(int), typeof(Vector3) })]  // перегрузка
AccessTools.Method(typeof(Spawner), "Spawn", new[] { typeof(int), typeof(Vector3) });

[HarmonyPatch(typeof(Player), nameof(Player.Speed), MethodType.Getter)]                      // свойство
AccessTools.PropertyGetter(typeof(Player), nameof(Player.Speed));
AccessTools.PropertySetter(typeof(Player), nameof(Player.Speed));

[HarmonyPatch(typeof(Unit), MethodType.Constructor, new[] { typeof(int) })]                  // конструктор
AccessTools.Constructor(typeof(Unit), new[] { typeof(int) });
```

`ref`/`out` в сигнатуре — `typeof(int).MakeByRefType()`. Явная реализация интерфейса в IL2CPP-interop имеет имя `Namespace_IИнтерфейс_Метод` [V FBS]. В IL2CPP геттеры часто инлайнены — патч свойства может не срабатывать [I]; конструкторы IL2CPP-типов патчить рискованно — лучше `Awake`/`Init` [I].

## 7. Включение и выключение

- Дешёвый prefix на редком методе — оставить установленным, поведение по статическому флагу [V IronFrontier].
- Горячий метод (тысячи вызовов в кадр) или сетевой обработчик — ставить при включении функции, снимать при выключении и смене уровня [V Toybox, общий принцип core.md]:

```csharp
harmony.Patch(target, prefix: new HarmonyMethod(typeof(Hooks), nameof(Hooks.Prefix)));
harmony.Unpatch(target, HarmonyPatchType.Prefix, harmony.Id);   // только свои патчи
harmony.UnpatchSelf();                                          // всё своё при выгрузке
```

Не снимать чужие патчи (`Unpatch` без id). Проверка: `Harmony.GetPatchInfo(target)` → `Prefixes`/`Postfixes`/`Owners` [I].

## 8. Порядок и совместимость

`[HarmonyPriority(Priority.High)]`, `[HarmonyBefore("id")]`, `[HarmonyAfter("id")]` — если с той же точкой работают другие моды (UnityExplorer и пр.) [I].

## 9. Что нельзя или трудно в IL2CPP

| Что | Почему | Как обойти |
|---|---|---|
| Transpiler | у interop-метода нет IL-тела игры | prefix с полной заменой (`return false`) [I] |
| Инлайненные геттеры/мелкие методы | в нативном коде вызова нет | патчить вызывающих [I] |
| Пустые методы с общим RVA | патч срабатывает у всех | не патчить; сверить RVA в дампе [V FBS] |
| Методы generic-классов, generic-методы | общий код для ссылочных типов | патчить негенерик-вызывающего [I] |
| Методы, вызываемые только из Burst/Jobs | не через IL2CPP-вызов | данные, не патч [I] |
| `___field` | поля — свойства interop | `__instance.Field` [I] |
| Патч приватного метода по строке | имя меняется с обновлением | `nameof`, где член есть в interop; HookReport [V FBS] |

## 10. Правила

- Каждое тело патча — в try/catch; при ошибке оригинал работает.
- В патче — без файлов, логов на каждый вызов и `FindObjectsOfType`: только флаги и простая арифметика.
- Патч вызывается в потоке игры, но не обязательно главном (сеть, загрузка) — Unity API из него только если метод заведомо на главном потоке.
- Захваченный `__instance` проверять на живость перед использованием.
