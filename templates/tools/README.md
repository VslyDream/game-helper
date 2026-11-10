# Инструменты разработки адаптера

Только стандартная библиотека Python 3.9+. Скопировать в `tools/` проекта.

| Файл | Что делает |
|---|---|
| `paths.example.json` | Единственный источник абсолютных путей: папка игры, exe, Steam AppID, `apiBase`, команда сборки, InteropFix, лог, папка кадров, список `forbidden`. Скопировать в `paths.json` рядом с проектом. Пути больше нигде не дублировать: в прошлом проекте они были в пяти местах. |
| `dev_cycle.py` | Цикл одной командой: `game.close` через API → ожидание выхода процесса → ожидание, пока Steam отпустит игру (`Remove <appid> from running list` в `logs/gameprocess_log.txt`) → сборка (csproj сам копирует DLL) → InteropFix → запуск (`steam://rungameid/<id>` или exe без `DOORSTOP_*`) → опрос `/api/state` до `readyState` → `afterReady` / `--snapshot` → `--shot`. При сбое печатает ошибки из `BepInEx/LogOutput.log`. |
| `helper_cli.py` | CLI агента: `state [--short]`, `act <command> [json]`, `cheat <id> <value>`, `wait`, `shot <file>`, `log [n]`, `commands`, `inspect types/find/get/set/invoke`. Работает с тем же API, что панель и MCP. |

```
python tools/dev_cycle.py --shot after.png         # пересобрать, перезапустить, дождаться уровня, снять кадр
python tools/helper_cli.py state --short
python tools/helper_cli.py inspect find --type PlayerController
```

Команды из `forbidden` (удаление сейвов, сброс прогресса и т. п.) не отправляет ни один из инструментов.
Кадр, который агент сам открыл и просмотрел, вместе с логом — доказательство результата. Слова «должно работать» им не являются.
