# Unity: где искать по функциям

Шпаргалка `rg` для функций съёмки трейлеров. Источник поиска: `decompiled/` (Mono или BackUp-папка) или дамп `_types.tsv` / `_members.tsv` / `_strings.txt` (IL2CPP). Примеры классов из конкретных игр помечены названием игры — в новой игре их нет. Найденное записать в `docs/` с [I], проверить в игре до обещания.

Общий приём: сначала стандартные типы Unity (их имена стабильны), затем — чьи поля имеют эти типы и кто их вызывает.

```bash
rg -n "Camera|Cinemachine" research/dump/_members.tsv | rg -v "^UnityEngine|^Cinemachine\t" | head -50
rg -n ": MonoBehaviour" decompiled/ | rg -i "camera|time|weather|hud|input|spawn|save"
```

## Камера и фрикамера

- Искать: `Camera.main`, `CinemachineBrain`, `CinemachineVirtualCamera`, `CinemachineFreeLook`, `CinemachineCamera` (v3), `Priority`, свои `CameraController`/`CameraRig`/`CameraFollow`, `LateUpdate` в них; URP — `UniversalAdditionalCameraData`, `cameraStack`; HDRP — `HDAdditionalCameraData`; постэффекты — `Volume`, `VolumeProfile`, `DepthOfField`, PPv2 `PostProcessLayer`/`PostProcessVolume`.
- Что работает лучше всего — **управлять камерой самой игры** [V FBS]: выключить `CinemachineBrain` (или свой контроллер камеры игры) и каждый кадр писать `transform`, `fieldOfView`. Картинка, небо, постэффекты, туман те же; второго рендера нет; всё, что целится от `Camera.main`, работает. Выключение — вернуть `brain.enabled = true`.
- Второй вариант — своя vcam Cinemachine с приоритетом выше всех [I]: даёт бленды, но спорит с игровыми vcam (катсцены, спектатор).
- Отдельная вторая камера поверх — крайний случай [V FBS 0.1]: двойной рендер, `Camera.CopyFrom` не переносит URP-данные, постэффекты, skybox, слои volume — цвета другие.
- Встроенная камера разработчиков (spectator, photo mode, `FreeFlyCamera`) — проверить её первой: может хватить включения [V FBS: есть, но не всё умеет].
- Глубина резкости URP/HDRP: свой глобальный `Volume` с высоким `priority` и профилем из `ScriptableObject.CreateInstance(Il2CppType.Of<VolumeProfile>())`; параметры через `.Override(...)` [V FBS].
- Качество для съёмки: `QualitySettings.lodBias`, `maximumLODLevel`, `shadowDistance`; URP-ассет — дистанция теней, каскады, разрешение shadowmap; `Terrain.activeTerrains` — дистанции деталей и деревьев; `Camera.layerCullDistances`, occlusion; TAA через `UniversalAdditionalCameraData.antialiasing`. Всё возвращать при выключении и выходе с уровня [V FBS]. Стриминг и pop-in полностью не убираются.
- 2D/RTS: у контроллера камеры игры поля границ, краевой прокрутки, зума — править их, не ставить свою камеру [V IronFrontier: краевая прокрутка отключена отрицательным порогом].

## Время, день и ночь, погода

- Пауза и скорость: `Time.timeScale` (0 — пауза; UI и `unscaledDeltaTime` идут). Многие игры держат свою скорость: `GameTime`, `TimeManager`, `SetTimeFlowSpeed`, `GameSpeed` — менять через них, иначе игра перепишет [V IronFrontier]. При выходе с уровня — вернуть 1 [V FBS]; после перезапуска пауза не восстанавливается (CORE-17).
- Время суток: `TimeOfDay`, `DayNight`, `Clock`, `Hour`, `SetTime`, `DayTime`, сервисы времени на сервере в сетевых играх [V FBS: серверный сервис времени + сторонний `EnvironmentManager`].
- Погода и небо: `Weather`, `Rain`, `Fog`, `Sky`, `Cloud`, ассеты Enviro, COZY, UniStorm, Expanse, Weather Maker, Tenkoku [I]; HDRP — `Volume` с облаками/туманом.
- Полёт фрикамеры на паузе — по `unscaledDeltaTime` [V FBS].

## Интерфейс (HUD)

- Сначала родная клавиша/метод скрытия UI игры (`UIHide`, `HideHUD`, `ToggleUI`) [V FBS: есть у игры].
- uGUI: `Canvas.enabled = false` у всех включённых канвасов, включая вложенные, и вернуть **ровно скрытые**; пропускать свои и инспекторов (UnityExplorer) [V IronFrontier]. `CanvasGroup.alpha` — если канвас нельзя выключить без побочных эффектов.
- UI Toolkit: `UIDocument.rootVisualElement.style.display = None` [I].
- Мировой UI: никнеймы, полоски HP, маркеры — отдельные компоненты/флаги (`showHpBar`, `Nameplate`, `WorldSpace` канвасы), миникарта [V IronFrontier]. Overlay-камера UI в стеке URP — выключить её [I FBS: overlay `UI_3D`].
- Подсветка выделения, курсор, прицел, руки от первого лица — отдельные пункты чек-листа съёмки.

## Ввод

- Новая система: JSON `InputActions` в `_strings.txt` (карты, действия, привязки) [V FBS]; `InputActionAsset`, `PlayerInput`, `InputActionMap.Enable/Disable`, `SubscribeAction`, контексты ввода. Старая: `Input.GetKey*`, `Input.GetAxis`, `KeyCode.`.
- Блок игрока во время фрикамеры: выключать **компонент контроллера ввода/движения** игрока и держать выключенным каждый кадр [V FBS]; отключать всю карту действий — риск сломать меню/паузу.
- Свой ввод фрикамеры: `Keyboard.current`, `Mouse.current.delta` или `Input.*` — только при `Application.isFocused` и активном окне игры (CORE-11).
- Встроенные клавиши игры и конфликт хоткеев — из привязок; список опасных клавиш (DEV-03) [V оба].

## ИИ и NPC

- `NavMeshAgent` (`isStopped`, `speed`, `SetDestination`), деревья поведения (`BehaviorTree`, `Behavior Designer`, `NodeCanvas`), машины состояний (`State`, `FSM`, `Brain`), восприятие (`CanSee`, `Perception`, `Detect`, `FindTarget`, `GetClosest`).
- Спавн и волны: `Spawner`, `Spawn`, `Wave`, `Director`, `Pool`, `Squad` [V IronFrontier, V FBS].
- Невидимость для врагов — патч выбора цели/восприятия; заморозка — `isStopped` + `Animator.speed = 0` [I]. Убрать NPC — через сервис игры (деспавн), не `Destroy` [V FBS: спавн/деспавн только через сервис].
- Аниматор: игровой `Update` переписывает параметры каждый кадр [V FBS].

## Персонаж

- Урон: `TakeDamage`, `DoDamage`, `ApplyDamage`, `Hit`, `Health`, `Die`, `Kill`. Бессмертие — prefix на получении урона; пропускать скриптовые убийства (огромный урон) [V IronFrontier].
- Выносливость, перезарядки, патроны: `Stamina`, `Cooldown`, `Ammo`, `Consume`.
- Движение и телепорт: `CharacterController` нужно выключить на время записи `transform.position` [V FBS]; `Rigidbody` — `MovePosition`/`isKinematic`.

## Сейвы

- `PlayerPrefs` (реестр), `Application.persistentDataPath`, `File.WriteAll*`, `SaveManager`, `SaveSystem`, `Slot`.
- Easy Save: `ES3.Save/Load`, файлы `*.es3`, `ES3Settings`; бывает plain JSON с `__type`, бывает шифрование паролем из кода [V IronFrontier plain].
- `JsonUtility`, `Newtonsoft`, `BinaryFormatter`, `MessagePack`; Steam Cloud — сейв может вернуться из облака.
- Снимки делать штатным сохранением игры и её загрузкой, не своей сериализацией мира [V IronFrontier]. Бэкап слота до операций; одноразовый слот для служебных загрузок [V IronFrontier].

## Предметы и справочник

- ScriptableObject-базы: `ItemDatabase`, `*Config`, `*Data`, `*Definition`, `*SO`, `Catalog`, `Registry`; конфиги сторонних форматов [V FBS].
- Addressables: `catalog.json` в `StreamingAssets/aa`; ключи и адреса префабов [V FBS].
- Выгрузка — UnityPy в JSON; id из пресетов проверяются при подключении (CORE-22).

## Локализация

`Unity.Localization` (`StringTable`, `LocalizedString`), I2 (`LocalizationManager.GetTranslation`), свои CSV/JSON. Нужна для человеческих имён в справочнике.

## Отладка и встроенные читы

```bash
rg -n -i "cheat|debug|devmenu|console|godmode|isDebugBuild|IsProduction|noclip" decompiled/ research/dump/_members.tsv
rg -n "GetKeyDown\(KeyCode\.(F[0-9]+|[A-Z])\)" decompiled/
```

- Встроенные панели и консоли (Jahro, SRDebugger, Quantum Console) — включаются флагом или байтом в ассете [V IronFrontier].
- Каждую найденную отладочную клавишу — в список опасных (DEV-03): бывают клавиши, стирающие прогресс [V IronFrontier].

## Сцены и состояние

`SceneManager.sceneLoaded`, `GetActiveScene().name/buildIndex`, загрузочные экраны, `LoadSceneAsync`, Addressables-сцены. Состояния панели «меню / уровень / загрузка» строить по сценам плюс живости ключевых менеджеров [V оба].
