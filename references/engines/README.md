# Движки: что читать

Читать после первичного осмотра папки игры, только нужное. Пометки: **[V]** — проверено в наших проектах, **[I]** — внешние источники или вывод.

| Ситуация | Файл |
|---|---|
| Любая Unity-игра, первые 10 минут | [unity-detect.md](unity-detect.md) |
| Unity + IL2CPP (`GameAssembly.dll`) — основной случай | [unity-il2cpp-bepinex6.md](unity-il2cpp-bepinex6.md) |
| Unity + Mono (`Managed/Assembly-CSharp.dll`) | [unity-mono-bepinex5.md](unity-mono-bepinex5.md), общие части — в IL2CPP-плейбуке |
| Ищем камеру, время, HUD, ввод, ИИ, сейвы в коде Unity | [unity-where-to-look.md](unity-where-to-look.md) |
| Unreal Engine 4/5 (`*-Win64-Shipping.exe`, `.pak`) | [unreal-ue4ss.md](unreal-ue4ss.md) |
| Патчи HarmonyX (IL2CPP и Mono) | [../harmony-cheatsheet.md](../harmony-cheatsheet.md) |
| Что-то пошло не так | [../pitfalls.md](../pitfalls.md) — сначала поиск по симптому |

Порядок выбора маршрута — от дешёвого к дорогому: встроенные читы/консоль игры → загрузчик и API игры (вызов её же методов) → правка данных/ассетов → Harmony-патч поведения → нативный хук. Маршрут и причину выбора записать в `docs/02_engine.md` до начала работы.

Другой движок (Godot, собственный, Source) — плейбука нет: осмотреть так же (версия, загрузчики сообщества, скриптовый слой, античит), записать находки, предложить пользователю маршрут до работы.

Онлайн-игры с античитом и соревновательные режимы — вне рамок набора (см. `unity-detect.md` §8).
