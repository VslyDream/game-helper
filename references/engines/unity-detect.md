# Unity: распознать сборку

Цель — за один проход ответить: Mono или IL2CPP, версия Unity и метаданных, рендер, ввод, камера, DI, сеть, установленные загрузчики, античит. Ответы — в `docs/02_engine.md` с пометками [V]/[I] (DEV-01, DEV-02). Папку игры только читать.

## 1. Mono или IL2CPP

| Признак | Mono | IL2CPP |
|---|---|---|
| `<Game>_Data/Managed/Assembly-CSharp.dll` | есть | нет |
| `GameAssembly.dll` рядом с exe | нет | есть |
| `<Game>_Data/il2cpp_data/Metadata/global-metadata.dat` | нет | есть |
| `MonoBleedingEdge/` рядом с exe | есть | нет |

Mono → [unity-mono-bepinex5.md](unity-mono-bepinex5.md). IL2CPP → [unity-il2cpp-bepinex6.md](unity-il2cpp-bepinex6.md).

## 2. Версия Unity

- `UnityPlayer.dll` → ProductVersion: `(Get-Item UnityPlayer.dll).VersionInfo.ProductVersion` → `2022.3.62f3 (96770f904ca7)` [V FBS].
- `<Game>_Data/globalgamemanagers` — та же строка в заголовке: `head -c 64 globalgamemanagers | strings` [V FBS].
- `Player.log` — версия движка в первых строках [V IronFrontier].
- `boot.config` с `player-connection-*` — development build: в коде вероятны рабочие debug-ветки [V IronFrontier].

## 3. Метаданные IL2CPP и дампер

Первые 8 байт `global-metadata.dat`: magic `AF 1B B1 FA` (0xFAB11BAF) и int32 версия.

```bash
python -I -c "import struct,sys;d=open(sys.argv[1],'rb').read(8);print(hex(struct.unpack('<I',d[:4])[0]),struct.unpack('<i',d[4:])[0])" "<Game>_Data/il2cpp_data/Metadata/global-metadata.dat"
```

Другой magic или мусор в версии — метаданные зашифрованы/обфусцированы: дешёвого маршрута нет, сообщить пользователю до работы. Подверсию (24.4, 31.1) показывает дампер, не заголовок.

| Версия | Unity (примерно) | Чем дампить | |
|---|---|---|---|
| 24.x | 2018.3–2020.1 | Il2CppDumper, Cpp2IL | [I] |
| 27.x | 2020.2–2021.1 | Il2CppDumper, Cpp2IL | [I] |
| 29.x | 2021.2–2022.2 | Il2CppDumper (последняя, что он знает), Cpp2IL | [I] |
| 31.x | 2022.3 (и 2023.x) | Cpp2IL / LibCpp2IL; Il2CppDumper — только форки | [V FBS: 2022.3.62 = 31.1] |
| 39 | Unity 6 (6000.x) | Cpp2IL 2022.1.0-pre-release.21; форки Il2CppDumper под v39 | [V IronFrontier: 6000.4.8 = 39] |

Il2CppDumper (Perfare) не развивается с 2024 [I]. Cpp2IL для v39 даёт dummy-DLL без атрибутов `[Address]` [I]. Часто отдельный дампер не нужен: BepInEx 6 сам прогоняет Cpp2IL и генерирует interop, а сигнатуры видны в interop-DLL.

## 4. Бесплатные исходники

`<Game>_BackUpThisFolder_ButDontShipItWithYourGame/` — разработчик забыл удалить: `Managed/` (исходные managed DLL + PDB), `il2cppOutput/` (сгенерированный C++), `GameAssembly.pdb`. Тогда `ilspycmd -p -o decompiled <...>/Managed/Assembly-CSharp.dll` даёт полный код с именами локальных переменных [V IronFrontier]. Это лучший случай: дамп не нужен, сигнатуры точные. Рабочую копию игры делать без этой папки и `*_BurstDebugInformation_DoNotShip`. Декомпилированный код хранится локально и никуда не публикуется.

## 5. Пути к логу и сейвам

`<Game>_Data/app.info` — две строки: Company и Product. Отсюда:
- `%USERPROFILE%\AppData\LocalLow\<Company>\<Product>\` — `Player.log`, `Player-prev.log`, чаще всего и сейвы (`Application.persistentDataPath`) [V IronFrontier].
- `PlayerPrefs` на Windows — реестр `HKCU\Software\<Company>\<Product>` [I].
- Бывают сейвы в `Documents`, `Saved Games` или Steam Cloud (`<Steam>/userdata/<id>/<appid>/`) — искать `persistentDataPath`, `GetFolderPath`, `SteamRemoteStorage` в коде.

## 6. Стек игры по списку сборок

Список: Mono — `Managed/*.dll`; IL2CPP — `<Game>_Data/ScriptingAssemblies.json` или вывод дампера. В `ScriptingAssemblies.json` бывают сборки, которых нет в метаданных — сверять с дампом [V FBS].

| Сборка / признак | Что значит |
|---|---|
| `Unity.RenderPipelines.Universal.Runtime` | URP: постэффекты через `Volume`, у камеры `UniversalAdditionalCameraData`, стек камер [V FBS] |
| `Unity.RenderPipelines.HighDefinition.Runtime` | HDRP: `Volume`, `HDAdditionalCameraData`, физическая камера [I] |
| ни того ни другого | Built-in; постэффекты — `Unity.Postprocessing.Runtime` (PPv2, `PostProcessLayer`/`PostProcessVolume`) [I] |
| `Unity.InputSystem` | новая система ввода; искать JSON `InputActions` в строках [V FBS]. Наличие сборки не значит, что игра ею пользуется: проверить вызовы `Input.GetKey*` [V IronFrontier] |
| `Cinemachine` / `Unity.Cinemachine` (v3) | камерой рулит `CinemachineBrain` — фрикамера через него [V FBS] |
| `Zenject` / `VContainer` / `Grace` | DI: сервисы не синглтоны, берутся из контейнера [V FBS Grace; I остальные] |
| `Mirror` / `FishNet.Runtime` / `Unity.Netcode.Runtime` / `Photon*`, `Fusion` | сеть: даже в соло есть клиент и сервер, мир меняется только на хосте (CORE-09) [V FBS FishNet]. Photon/Fusion без своего хоста — облако, вероятно онлайн-игра [I] |
| `Unity.Addressables` | сцены и префабы в бандлах; каталог в `StreamingAssets/aa` [V FBS] |
| `ES3` / Easy Save, `Newtonsoft.Json`, `MessagePack`, `OdinSerializer` | формат сейвов [V IronFrontier ES3] |
| Jahro, SRDebugger, Quantum Console, IngameDebugConsole | встроенная отладочная консоль — источник готовых читов и опасных клавиш (DEV-03) [V IronFrontier Jahro] |
| Behavior Designer, NodeCanvas, `Unity.Behavior`, `Unity.AI.Navigation` | ИИ: деревья поведения + NavMesh [V FBS] |
| `Unity.Localization`, I2 Localization | таблицы строк для имён в справочнике [V FBS] |

Где что искать по функциям — [unity-where-to-look.md](unity-where-to-look.md).

## 7. Уже установленные загрузчики

Рядом с exe: `winhttp.dll` + `doorstop_config.ini` — Doorstop (BepInEx 5/6); `version.dll` — MelonLoader или старый Doorstop; `BepInEx/`, `MelonLoader/`, `Mods/`, `dotnet/`. `dwmapi.dll` — UE4SS, к Unity не относится. Найдено чужое — выяснить, чьё и какой версии, записать; молча не перезаписывать (CORE-16). Сообщество игры на MelonLoader — повод взять его, а не BepInEx [I].

## 8. Античит и онлайн — стоп

Признаки: папки `EasyAntiCheat/`, `BattlEye/`, файлы `start_protected_game.exe`, `EasyAntiCheat_EOS_Setup.exe`, `BEService*`; драйверы и службы других античитов; игра только онлайн с чужими игроками. Если найдено — загрузчик не ставить, игру с модом не запускать, сообщить пользователю что найдено и спросить. Набор рассчитан на одиночную игру и кооп с хостом у себя.

## 9. Что записать

```
Unity 2022.3.62f3, IL2CPP, metadata 31.1, x64        [V]
Рендер URP; камера Cinemachine FreeLook; ввод Input System   [V/I]
DI Grace; сеть FishNet (соло = хост)                 [I]
Лог: LocalLow\<Company>\<Product>\Player.log; сейвы: там же, ES3
Загрузчиков нет; античита нет; BackUp-папки нет
Маршрут: BepInEx 6 BE + Harmony, причина: …
```
