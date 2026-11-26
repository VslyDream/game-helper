# Unity IL2CPP + BepInEx 6 BE: плейбук

Основной маршрут для Unity-игр с `GameAssembly.dll`. Опыт двух проектов: FBS (Unity 2022.3.62, metadata 31.1, URP, Cinemachine, FishNet, Grace) и IronFrontier (Unity 6000.4.8, metadata 39, 2D, uGUI). Шаблоны кода — `templates/plugin-il2cpp/`. Патчи — [harmony-cheatsheet.md](../harmony-cheatsheet.md), грабли — [pitfalls.md](../pitfalls.md).

## 1. Выбор и закрепление сборки BepInEx

- Официальный `6.0.0-pre.2` (2024) для свежих Unity устарел; брать bleeding edge с builds.bepinex.dev: `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.<N>+<commit>.zip` [I].
- Номер BE и commit записать в `docs/02_engine.md` и в установщик. API плагинов меняется между BE-сборками: обновлять только осознанно, с пересборкой и самопроверкой (CORE-22).
- Проверено: **be.788** (Il2CppInterop 1.5.3, Doorstop 4.5.0, .NET 6.0.7) на 2022.3.62 [V FBS]; **be.791** на 6000.4.8 — только вместе с InteropFix (§4) [V IronFrontier].
- MelonLoader 0.7.x — альтернатива на том же Il2CppInterop, если сообщество игры на нём [I].
- Скачанные архивы — в отдельную папку проекта (`archive/downloads/`), чтобы переустановка не зависела от сети.

## 2. Установка

Ставить в **копию игры**, если игра запускается из копии (проверить: Steam DRM, лаунчер). Иначе — в папку Steam со списком установленных файлов для удаления. Перед первым запуском — бэкап сейвов (CORE-20).

1. Распаковать архив рядом с exe: `winhttp.dll`, `doorstop_config.ini`, `.doorstop_version`, `BepInEx/`, `dotnet/`. В `doorstop_config.ini`: `target_assembly = BepInEx\core\BepInEx.Unity.IL2CPP.dll`, `coreclr_path = dotnet\coreclr.dll` [V FBS].
2. Базовые библиотеки Unity BepInEx при первом запуске качает сам. Чтобы не зависеть от сети: положить их в `BepInEx/unity-libs/` и задать пустой `[IL2CPP] UnityBaseLibrariesSource =` в `BepInEx/config/BepInEx.cfg` [V FBS].
3. В `BepInEx.cfg` выключить консоль: `[Logging.Console] Enabled = false` — окно консоли видно пользователю и крадёт фокус [V FBS]. Если конфига ещё нет — создать заранее с этими ключами или поправить после первого запуска.
4. Первый запуск: Cpp2IL читает метаданные, Il2CppInterop пишет `BepInEx/interop/*.dll` (десятки секунд — минуты; окно игры появляется поздно; процесс не убивать). Признаки успеха в `BepInEx/LogOutput.log`: `Chainloader startup complete`, `N plugins to load`. Строка `Class::Init signatures have been exhausted` безвредна [V FBS].
5. После обновления игры BepInEx заново генерирует interop при старте — снова долгий запуск, затем InteropFix (если нужен) и пересборка плагина против нового interop [V IronFrontier].
6. Падение на первом запуске Unity 6: сначала InteropFix (§4); для части игр помогает `[Logging] UnityLogListening = false` [I].
7. Отключить мод без удаления: `winhttp.dll` → `winhttp.dll.disabled` [V FBS]. Удаление — по списку файлов установки; сейвы и данные панели не трогать (CORE-16).

## 3. Doorstop и дочерние процессы

Doorstop помечает процесс игры переменными `DOORSTOP_*`. Процесс, запущенный из плагина, их наследует, и игра, запущенная потом из такого процесса (панель → «Запустить игру»), стартует **без мода**. Вычищать `DOORSTOP_*` из окружения дочерних процессов [V IronFrontier]. Запуск сервиса панели из плагина — §13.

## 4. Unity 6: «Duplicate type '<>O'» и InteropFix

Симптом: CoreCLR падает при загрузке interop: `BadImageFormatException: Duplicate type with name '<>O' in assembly 'UnityEngine.CoreModule'` [V IronFrontier, be.791 + 6000.4]. Il2CppInterop пишет таблицы метаданных для вложенных compiler-generated типов (`<>O`, `<>c`) так, что рантайм их отвергает.

Решение — `templates/plugin-il2cpp/InteropFix/`: консольная утилита на Mono.Cecil читает каждую DLL из `BepInEx/interop` и записывает обратно (Cecil нормализует таблицы). Оригинал — `*.dll.orig` один раз; маркер `interop.fixed` хранит имя+время каждой DLL, чтобы повторный прогон без перегенерации ничего не делал. Запускать перед каждым стартом игры (цикл разработки, сервис панели): дёшево, когда маркер совпадает.

## 5. Сборка до первого запуска

Плагин можно собрать до того, как BepInEx сгенерировал interop: прогнать тот же конвейер офлайн (Cpp2IL/LibCpp2IL + Il2CppInterop) в `research/interop/` и собрать с `-p:InteropDir=..\research\interop` [V FBS]. Офлайн-interop должен совпадать с тем, что сгенерирует BepInEx; после первого настоящего запуска собирать против `BepInEx/interop`. Если офлайн-конвейер не нужен — просто запустить игру с BepInEx один раз.

## 6. csproj

Образец — `templates/plugin-il2cpp/` (csproj). Главное:

- `net6.0`, `LangVersion latest`, `AllowUnsafeBlocks`, `AppendTargetFrameworkToOutputPath=false`, `CopyLocalLockFileAssemblies=false`.
- Свойства `GameDir` и `InteropDir` с умолчанием и переопределением через `-p:` — никаких абсолютных путей в коде.
- Ссылки `HintPath` + `Private=false`: из `BepInEx/core` — `BepInEx.Core`, `BepInEx.Unity.IL2CPP`, `BepInEx.Unity.Common`, `0Harmony`, `Il2CppInterop.Runtime`, `Il2CppInterop.Common`; из interop — `Il2Cppmscorlib`, `UnityEngine.CoreModule` и нужные модули (`UnityEngine.UI`, `ImageConversionModule`, `ScreenCaptureModule`, `InputLegacyModule`…), `Assembly-CSharp` и сборки игры. Можно `$(InteropDir)\*.dll` целиком [V IronFrontier].
- Таргет `AfterTargets="Build"` копирует DLL (и пресеты) в `BepInEx/plugins/<Имя>/` [V IronFrontier].
- `MSB3027`/файл занят — игра держит DLL: закрыть игру до сборки (это делает цикл разработки).
- Офлайн-NuGet: `NuGet.Config` рядом с csproj с `<clear/>` и локальным источником (нужен только ref-pack `Microsoft.NETCore.App.Ref 6.0.x`) [V FBS].

## 7. Скелет плагина

```csharp
[BepInPlugin(Guid, "Game Helper", Version)]
public class Plugin : BasePlugin {
    public override void Load() {                // поток загрузчика: Unity ещё не готова
        L = Log;
        AddComponent<Runner>();                  // регистрирует тип в IL2CPP и вешает на скрытый объект
        HookReport.Install(new Harmony(Guid));   // ручные патчи с проверкой installed/missing
        Commands.RegisterAll();
        Api.Start(Port);                         // фоновый поток: только разбор запроса → Runner.Invoke
        HelperService.EnsureRunning();           // сервис панели, отдельным процессом (§13)
    }
}
```

- В `Load` и в потоках сети — **никаких Unity API** (включая `Debug.*`, `Application.*`, поиск объектов): зависание или падение процесса [V IronFrontier]. Всё игровое — через `Runner`.
- Шаблоны: `Plugin.cs`, `Runner.cs`, `Api.cs`, `HookReport.cs`, `DetachedProcess.cs`, `Screenshot.cs` в `templates/plugin-il2cpp/`.

## 8. Главный поток: Runner

`Runner : MonoBehaviour` в `Update`:
- разбирает `ConcurrentQueue<Action>` (`Post`); `Invoke<T>(func, timeoutMs)` — вызов с потока сети с ожиданием результата и понятной ошибкой по таймауту («игра не ответила — идёт загрузка?»);
- шагает долгие операции — **управляемые итераторы**: `yield return null` — следующий кадр, `yield return new Wait(сек)` — пауза по `Time.unscaledTime` (работает на паузе), `yield return (Func<bool>)(() => условие)` — ждать условия. IL2CPP-корутины (`StartCoroutine`) требуют обёрток Il2Cpp-IEnumerator — не нужны [V IronFrontier];
- на первом кадре ставит `Application.runInBackground = true` и периодически переустанавливает (игра может сбросить при смене настроек) — CORE-19 [V оба];
- каждое действие в try/catch: исключение логируется и не роняет цикл.

Ответ «выполнено» отдаётся только после действия, не при постановке в очередь (CORE-07) [V FBS: команда денег считалась выполненной до попытки].

## 9. Свои типы в IL2CPP

- Свой `MonoBehaviour` должен быть зарегистрирован: `ClassInjector.RegisterTypeInIl2Cpp<T>()` до `AddComponent`; `BasePlugin.AddComponent<T>()` делает это сам [V].
- Обязателен конструктор `public T(IntPtr ptr) : base(ptr) {}`. Сообщения Unity (`Update`, `LateUpdate`, `OnGUI`) находятся по имени.
- Управляемые поля такого класса не сериализуются и не видны в инспекторах; держать состояние в статиках/обычных классах проще.

## 10. Типы, приведения, коллекции

- Interop повторяет пространства имён игры; приватные поля и члены видны как свойства, `internal` доступен [V FBS].
- `obj.TryCast<T>()` — `null`, если не тот тип; `obj.Cast<T>()` — исключение. Нужно для интерфейсов и базовых классов из контейнеров [V].
- `Il2CppType.Of<T>()` — везде, где игра ждёт `System.Type`: `GetComponent(Type)`, `ScriptableObject.CreateInstance(Type)`, `Locate/Resolve(Type)` [V FBS].
- Структура → интерфейс: `value.BoxIl2CppObject().Cast<IИнтерфейс>()` [V FBS].
- **Структуры, полученные через интерфейс, читаются со сдвигом полей на 16 байт** (Il2CppInterop 1.5.3). Не доверять их свойствам; читать данные иначе и сверять id конфига. Передавать такие значения обратно в методы игры можно [V FBS].
- Явные реализации интерфейсов называются `Namespace_IИнтерфейс_Метод` [V FBS].
- `Il2CppSystem.Collections.Generic.List<T>` и `Dictionary` — не `System.*`; копировать в управляемые списки циклом. Интерфейсные коллекции (`.Values` как `ICollection`) могут не иметь перечислителя — перебирать сам словарь [V IronFrontier].
- Живость объекта: `o != null && !o.WasCollected` — после смены сцены ссылки «живые» в C#, но мёртвые в Unity [V IronFrontier].
- Делегаты в игру: `DelegateSupport.ConvertDelegate<T>(…)`. Если игра вызывает колбэк рефлексией (`MethodInfo.Invoke`) — такой делегат падает «Object does not match target type»; конец операции отслеживать опросом [V FBS].
- Generic-методы игры (`Send<T>`, `Show<T>`) работают только для инстанциаций, которые есть в билде; надёжнее звать негенерик-перегрузки или конкретные сервисы [I].

## 11. Как добраться до объектов игры

По убыванию надёжности:
1. **Статические синглтоны** (`Instance`, `GenericSingleton<T>.Instance`) [V IronFrontier].
2. **Postfix на методе жизненного цикла** (`Awake`, `Start`, `OnServerReady`, `OnClientReady`, `Init`) — сохранить `__instance` [V FBS]. Проверять, что метод не общая пустая заглушка (§12).
3. **DI-контейнер**: Grace — статический корневой контейнер → `Locate(Il2CppType.Of<IService>())?.TryCast<IService>()` [V FBS]; Zenject — `ProjectContext.Instance.Container.Resolve(Il2CppType.Of<T>())`, сценовые — через `SceneContext` [I]; VContainer — `LifetimeScope.Container.Resolve` [I]. Негенерик-перегрузки надёжнее generic [I].
4. **Поля других объектов** (UI, отладочные панели) с готовыми ссылками на сервисы [I].
5. `FindObjectOfType/FindObjectsOfType` — дорого: только по событию, с кэшем, не в опросе состояния 4 раза в секунду [V FBS].

Кэши сбрасывать при смене сцены и проверять живость (§10). В сетевых играх сервисы готовы заметно позже загрузки плагина; роль (solo/host/client) определять по фактическому серверу (CORE-09) [V FBS].

## 12. Особенности патчей в IL2CPP

Подробно — [harmony-cheatsheet.md](../harmony-cheatsheet.md). Коротко:
- Патч ставится на нативный код; transpiler не работает [I].
- Мелкие геттеры/сеттеры IL2CPP инлайнит: патч на них не срабатывает — патчить вызывающих [I IronFrontier].
- **Общие пустые заглушки**: компилятор сливает одинаковые пустые методы в один адрес (одинаковый RVA в дампе). Патч сработает на все — не патчить никогда; сверять RVA в дампе [V FBS: `OnServerLost` у всех сервисов].
- Методы generic-классов разделяются между инстанциациями — патч трудный и широкий; патчить негенерик-вызывающего [I].
- Приватные методы по строковым именам ломаются после обновления — `nameof`, где interop даёт член, и самопроверка (CORE-22) [V FBS].
- Каждый патч — через `AccessTools` + `Harmony.GetPatchInfo` с записью `installed/missing` в `HookReport`; провал отключает только зависимые читы [V FBS].
- Игровой `Update` может каждый кадр перезаписывать то, что мы выставили (параметры Animator) — prefix `return false` на `Update` только у помеченных объектов [V FBS].

## 13. Сервис панели рядом с игрой

- Стандарт — пара «мод + сервис»: мод внутри игры привязан к движку, сервис рядом с игрой — нет. Сервис отдаёт сайт, запускает и закрывает игру, хранит снимки и настройки; набор требует, чтобы он был, но готового не даёт.
- Проверенный образец сервиса — проект FBS владельца (`service/`, Python, только стандартная библиотека) [V FBS]. Смотреть его, если следующая игра на этом же движке.
- Брать можно то, что не знает об игре: связь с адаптером (приветствие с версией и сборкой, запрос и ответ по `id`, таймауты), хранение настроек, запуск с проверкой занятого порта, работу с окнами и процессами Windows, снимки.
- Не брать: константы игры (appid, exe, заголовок окна) и модули её систем. Имитация игры для проверки сервиса и сайта там же (`tools/mock_adapter.py`) — возможность, не обязанность.
- Плагин сам поднимает сервис панели, если порт свободен (`HelperService`), — панель доступна при запуске игры ярлыком [V IronFrontier].
- **Steam считает своими всех потомков процесса игры** и держит игру «запущенной», пока они живы (+~76 с даже с `CREATE_BREAKAWAY_FROM_JOB`). Запускать сервис через WMI `Win32_Process.Create` — родителем становится WmiPrvSE, Steam отпускает игру за ~3 с; breakaway — запасной путь (`DetachedProcess.cs`) [V FBS].
- Вычищать `DOORSTOP_*` (§3). Без окна консоли (`pythonw`, `CREATE_NO_WINDOW`).

## 14. Связь с панелью

Два проверенных варианта (контракт — `contracts/adapter.md`):
- `HttpListener` на `127.0.0.1:<порт>` в плагине: `/api/state`, `/api/action`, `/api/screenshot`; проверка Origin; повтор по `id` не выполняется дважды [V IronFrontier]. Проще отлаживать `curl`.
- TCP JSON-строки сервис ↔ адаптер, кэш ответов по id, отложенные ответы для долгих команд [V FBS]. Удобно для потока событий.
- Файловый обмен (request/response JSON) — только если иначе нельзя: опрос, гонки, подтверждение раньше выполнения [V Toybox/FBS 0.1].

Поток сети только разбирает запрос и зовёт `Runner.Invoke`. Состояние собирается на главном потоке, дешёвое.

## 15. Скриншоты

- Unity 6: `ScreenCapture.CaptureScreenshot(string)` через interop не работает (маршалинг `ReadOnlySpan`) → `CaptureScreenshotAsTexture()` + `ImageConversion.EncodeToPNG`, текстуру уничтожать; только главный поток [V IronFrontier]. Шаблон `Screenshot.cs`.
- Без HUD: рендер камеры в `RenderTexture`; быстрый путь — `AsyncGPUReadback` (члены запроса принимают `ref this` — вызывать на копии на стеке, не на поле) [V FBS]. Кодирование PNG — фоновым потоком из сырых байт [V FBS].
- Кадр в текстуру бывает перевёрнут: `ScreenCapture.CaptureScreenshotIntoRenderTexture` на D3D (`SystemInfo.graphicsUVStartsAtTop`) оставляет строки сверху вниз, а кадр камеры в `RenderTexture` читается снизу вверх. Переворот выбирать по источнику кадра; кодировщики Unity ждут порядок снизу вверх [V FBS].
- Агенту — уменьшенные кадры (`maxWidth`), и смотреть их на самом деле.

## 16. Исследование кода

Порядок:
1. `*_BackUpThisFolder_ButDontShipItWithYourGame/Managed` есть → `ilspycmd -p -o decompiled <Managed>/Assembly-CSharp.dll`, дальше `rg` по исходникам [V IronFrontier].
2. Иначе дамп метаданных (дампер — `unity-detect.md` §3) в C#-подобный текст с RVA и смещениями полей + таблицы для `rg` [V FBS]:
   - `_types.tsv`: сборка, тип, вид, база, интерфейсы, размер;
   - `_members.tsv`: строка на член (тип, имя, сигнатура, RVA/смещение);
   - `_strings.txt`: строковые литералы — JSON `InputActions`, ключи сейвов, имена параметров Animator, команды консоли.
   Пример: `rg -i "\tHealth\b" research/dump/_members.tsv`.
3. Interop-DLL (`BepInEx/interop` или офлайн): `ilspycmd` показывает точные сигнатуры, как их видит компилятор плагина (без тел) [I].
4. Данные: ScriptableObject-конфиги, каталоги, баланс — UnityPy (+ генератор type tree для IL2CPP) → JSON в `dumps/configs/`; Addressables — `catalog.json` [V IronFrontier, V FBS].
5. Тела методов нужны редко: дизассемблер по RVA (LibCpp2IL + Iced — FBS), Ghidra/IDA через MCP — только если без тела не решить; с `GameAssembly.pdb`, если он есть [I]. Метод: строка → xref → функция, переименовывать по ходу, выводы подтверждать в игре.
6. Живая проверка: UnityExplorer (живой форк под BepInEx 6) — человеку [V IronFrontier]; агенту — свои inspect-команды в API (найти объекты типа, прочитать/записать поле) [I].
7. Новый билд: diff дампов типов и членов (DEV-04), список затронутых опор мода [V FBS].

## 17. Цикл разработки (DEV-05)

Одна команда: собрать → закрыть игру (команда API, затем `taskkill` по таймауту) → дождаться, что Steam отпустил игру (`<Steam>/logs/gameprocess_log.txt`: `Remove <appid> from running list`) → InteropFix → установить → запустить → опрашивать `/api/state` до уровня (до ~90 с) → `rg` ошибок в `LogOutput.log` → кадр [V FBS, V IronFrontier]. В скриптах автопрохода — список запрещённых кнопок (удаление сейвов) [V FBS].

## 18. Готово, если

- Номер BE, версия Unity и metadata записаны; консоль выключена; отключение одним переименованием.
- Плагин грузится, `HookReport` все `installed`, `runInBackground` включён.
- Ни одного Unity-вызова вне главного потока; долгие операции итераторами.
- Цикл разработки проходит без ручных шагов; сервис не держит игру в Steam.
