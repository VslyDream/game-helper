# Шаблон адаптера: Unity IL2CPP + BepInEx 6 BE

Заготовка плагина-адаптера по контракту `contracts/adapter.md`. Движок, грабли и порядок исследования —
[`references/engines/unity-il2cpp-bepinex6.md`](../../references/engines/unity-il2cpp-bepinex6.md).
Шаблон проверен сборкой против BepInEx 6.0.0-be.791 + Unity 6000.4 interop; в живой игре не запускался.

## Файлы

| Файл | Что делает |
|---|---|
| `GameHelper.csproj` | net6.0. `GameDir` обязателен, `InteropDir` (по умолчанию `$(GameDir)\BepInEx\interop`), ссылки `Private=false`. Не даёт собрать, пока игра запущена (`GameExe`, MSB3027), `-p:KillGame=true` закрывает её. После сборки копирует DLL в `BepInEx\plugins\GameHelper\` (`-p:Deploy=false` — не копировать). |
| `src/Plugin.cs` | `BasePlugin.Load`: конфиг, `AddComponent<Runner>`, перехваты, команды, API, автозапуск сервиса. В `Load` нельзя трогать Unity API. |
| `src/Runner.cs` | Главный поток: `Post`, `Invoke<T>` с таймаутом, долгие операции через итераторы (`Wait`, `Func<bool>`) вместо IL2CPP-корутин, `runInBackground` на первом кадре и повторно (CORE-19). |
| `src/Api.cs` | `HttpListener` 127.0.0.1: `GET /api/state`, `POST /api/action`, `GET /api/commands`, `GET /api/screenshot`. Проверяет Origin и Host, требует JSON для изменяющих запросов, хранит ответы на последние 64 `id`. Реестр: `Api.Register(command, handler, unavailable, info)`. |
| `src/State.cs` | Сборка состояния. Следит за сменой уровня: при входе повторно применяет читы (CORE-17) и запускает самопроверку, при выходе откатывает читы и ставит `timeScale = 1`. |
| `src/Commands.cs` | `game.close`, `cheat.set`, `cheat.run`, класс `Cheat` (apply/revert, сохранение в `ConfigEntry`), образцы: `exampleToggle`, `pause` (не запоминается), `speed` (0 после перезапуска сбрасывается). |
| `src/HookReport.cs` | `HookReport.Patch(...)` записывает, найден ли метод и встал ли патч. `Expect(...)` — живые проверки на уровне. Читы с проблемной зависимостью получают `availability["cheat:<id>"]` с причиной (CORE-22). |
| `src/Inspect.cs` | Команды только для агента: `inspect.types/find/get/set/invoke`, `log.tail`. Регистрируются при `[Dev] DevTools=true`. Ограничения описаны в начале файла. |
| `src/Screenshot.cs` | `CaptureScreenshotAsTexture` + `EncodeToPNG/JPG`, уменьшение, ожидание N кадров. Перегрузку `CaptureScreenshot(string)` на Unity 6 через interop не использовать. |
| `src/HelperService.cs`, `src/DetachedProcess.cs` | Запуск сервиса панели, если порт свободен. Процесс создаётся вне дерева игры через WMI (иначе Steam держит игру «запущенной»), переменные `DOORSTOP_*` убираются. |
| `InteropFix/` | Отдельная консольная утилита (Mono.Cecil), в сборку плагина не входит. |

## Переименование под игру

1. Переименовать `GameHelper` → `<Игра>Helper`: имя `.csproj`, `AssemblyName`/`RootNamespace`, `namespace GameHelper;` во всех `src/*.cs`, `Plugin.Name`.
2. `__GAME_ID__` в `Plugin.Guid` → короткий id игры (`local.mygame.helper`).
3. Порты `DefaultApiPort` / `DefaultServicePort` → свободная пара, своя для каждой игры (CORE-18). Те же значения прописать в `paths.json` (`apiBase`) и в сервисе панели.

## Сборка

```
dotnet build GameHelper.csproj -c Release -p:GameDir="D:\Games\MyGame" -p:GameExe=MyGame.exe
```
Обычно сборка запускается через `templates/tools/dev_cycle.py`, пути берутся из `paths.json`. До первого запуска игры с BepInEx папки interop нет: укажите `-p:InteropDir=...` (своя генерация) или один раз запустите игру. Нужен .NET SDK 6+; пакеты NuGet плагину не нужны.

## Что заполнить для игры

- `State.ComputeConnection` — точный признак меню и уровня: захваченный Harmony-postfix менеджер уровня или появившийся игрок. Заготовка различает их только по имени сцены и `[Game] MenuScenes`. `State.Role` — для сетевой игры.
- `Commands.InstallHooks` — перехваты через `HookReport.Patch`, проверки через `HookReport.Expect`.
- Читы в `Commands.RegisterAll`: `Id` совпадает с `config.json → cheats`, у каждого чита заданы `Hooks` и `Apply`/`Revert`. Пауза, ×0 и заморозка не запоминаются (CORE-17). Пропуск событий выполняется по CORE-21.
- `InteropRef` в `.csproj`: добавить сборки игры и модули Unity, которые нужны читам.
- `State.Build`: добавить секции выбранных модулей и только их.
- Настройки в `BepInEx\config\local.<id>.helper.cfg`: `[Service] Command/Autostart`, `[Api] AllowedOrigins`.

Неуверенные API помечены в коде `// [I] проверить`. Проверить их на первой игре и снять пометку.

## InteropFix

Когда нужен: BepInEx падает при загрузке interop с ошибкой
`BadImageFormatException: Duplicate type with name '<>O' in assembly 'UnityEngine.CoreModule'`.
Такое встречалось на BE be.791 с Unity 6000.x. Утилита пересохраняет каждую DLL в `BepInEx\interop` через Mono.Cecil,
оставляет `*.dll.orig` и пишет маркер `interop.fixed`. Если BepInEx не перегенерировал interop (игра не обновлялась),
повторный запуск ничего не делает. Поэтому утилиту безопасно вызывать перед каждым запуском (`interopFixCmd` в `paths.json`).

```
dotnet run -c Release --project InteropFix\InteropFix.csproj -- "<GameDir>\BepInEx\interop"   [--force | --restore]
```
Игра должна быть закрыта. Пакет Mono.Cecil 0.11.6 скачивается из NuGet один раз.
