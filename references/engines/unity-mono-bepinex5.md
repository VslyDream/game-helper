# Unity Mono + BepInEx 5

Признак: `<Game>_Data/Managed/Assembly-CSharp.dll` (см. [unity-detect.md](unity-detect.md)). В наших прошлых проектах Mono не было: всё ниже **[I]**, пока не проверено на первой Mono-игре. Общие части (сервис панели, связь, цикл разработки, поиск объектов, самопроверка) — в [IL2CPP-плейбуке](unity-il2cpp-bepinex6.md), здесь только отличия.

## 1. Загрузчик

- BepInEx 5 стабильной ветки, `5.4.23.x` (x64 для x64-игры) [I]. Номер записать в `docs/02_engine.md`.
- Распаковать рядом с exe (`winhttp.dll`, `doorstop_config.ini`, `BepInEx/`), запустить игру один раз — появятся `BepInEx/config/BepInEx.cfg` и `BepInEx/LogOutput.log`. Interop не генерируется: первый запуск быстрый.
- Консоль: `[Logging.Console] Enabled = false`. Отключение — переименовать `winhttp.dll`, как в BepInEx 6.
- BepInEx 6 для Mono существует, но экосистема плагинов и шаблонов — на 5.x; без причины не брать.
- Сообщество игры на MelonLoader — повод взять его.

## 2. Чтение кода

- `ilspycmd -p -o decompiled <Game>_Data/Managed/Assembly-CSharp.dll` — полный проект с телами методов; так же для других сборок игры (`Assembly-CSharp-firstpass`, сборки с именем студии). Дальше `rg` по `decompiled/`.
- Обфускация (бессмысленные имена `\u0001`, `A.b.c`) — проверить до обещаний; de4dot помогает не всегда.
- Сигнатуры, приватные поля, тела — всё доступно; дамп метаданных и TSV не нужны, но `rg -n "class |void |public "` по декомпиляции заменяет их.

## 3. Проект плагина

- Шаблон: `dotnet new install BepInEx.Templates --nuget-source https://nuget.bepinex.dev/v3/index.json`, затем `dotnet new bepinex5plugin -n <Имя> -T <netstandard2.1|net46> -U <версия Unity>` [I].
- Пакеты с `nuget.bepinex.dev`: `BepInEx.Core` (5.4.x), `BepInEx.PluginInfoProps` (генерирует `MyPluginInfo` из csproj), `UnityEngine.Modules` нужной версии Unity — либо ссылки `HintPath` на `Managed/UnityEngine*.dll` с `Private=false`.
- `TargetFramework`: `netstandard2.1` или `net46`–`net472` — по рантайму игры (`MonoBleedingEdge` + версия Unity) [I].
- Игровые сборки — `HintPath` на `Managed/Assembly-CSharp.dll` и др., `Private=false`; `GameDir` переопределяется через `-p:`.
- Приватные члены: `BepInEx.AssemblyPublicizer.MSBuild` и `Publicize="true"` на ссылке — компилятор видит всё как public; иначе `AccessTools`/`Traverse`.
- Копирование в `BepInEx/plugins/<Имя>/` таргетом после сборки — как в IL2CPP.

## 4. Скелет

```csharp
[BepInPlugin(MyPluginInfo.PLUGIN_GUID, MyPluginInfo.PLUGIN_NAME, MyPluginInfo.PLUGIN_VERSION)]
public class Plugin : BaseUnityPlugin {          // сам является MonoBehaviour
    void Awake() {
        new Harmony(MyPluginInfo.PLUGIN_GUID).PatchAll();
        Api.Start(Port);                         // фоновый поток → очередь главного потока
    }
    void Update() { Runner.Pump(); }             // очередь, итераторы, runInBackground
}
```

- `BaseUnityPlugin` — MonoBehaviour на объекте BepInEx: `ClassInjector`, конструктор с `IntPtr`, `TryCast`, `Il2CppType.Of` не нужны.
- Объект плагина могут уничтожить при смене сцены в отдельных играх — `DontDestroyOnLoad`/`HideFlags` или отдельный свой объект [I].
- Правило главного потока то же: Unity API — только из `Update`/корутин; сеть — через очередь.
- Корутины (`StartCoroutine(IEnumerator)`) работают штатно; управляемые итераторы из IL2CPP-шаблона тоже годятся.
- `ConfigEntry` (`Config.Bind`) — текстовый `.cfg`, агент может править файл; настройки панели всё равно храним по CORE-17.

## 5. Отладка

- `BepInEx.Debug`: **ScriptEngine** — горячая перезагрузка плагинов из `BepInEx/scripts` без перезапуска игры (только Mono); **DemystifyExceptions** — читаемые стеки.
- UnityExplorer (Mono-сборка для BepInEx 5), RuntimeUnityEditor — инспекторы для человека.
- `ConfigurationManager` (F1) — GUI для `ConfigEntry`, пользователю не нужен при веб-панели.

## 6. Чем проще, чем IL2CPP

| Тема | Mono | IL2CPP |
|---|---|---|
| Первый запуск | секунды | генерация interop, InteropFix на Unity 6 |
| Код игры | полный, с телами | дамп/interop без тел, кроме BackUp-папки |
| Патчи | prefix/postfix/transpiler, инлайна почти нет | без transpiler, инлайн геттеров, общие заглушки |
| Свои MonoBehaviour | обычные | регистрация в IL2CPP |
| Коллекции/типы | `System.*` | `Il2CppSystem.*`, `TryCast` |
| Хот-релоад | ScriptEngine | только перезапуск |

Что не меняется: сервис панели отдельным процессом без привязки к Steam (WMI), `DOORSTOP_*` у дочерних процессов, `runInBackground`, самопроверка патчей, цикл «собрать → закрыть → установить → запустить → дождаться уровня».
