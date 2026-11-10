#!/usr/bin/env python3
"""Цикл разработки одной командой. Только stdlib, пути — из paths.json (см. paths.example.json).

  закрыть игру через API (game.close) → дождаться выхода процесса → дождаться, пока Steam «отпустит» игру
  → собрать плагин (csproj сам копирует DLL в BepInEx\\plugins) → [InteropFix] → запустить игру
  → ждать /api/state до connection=<readyState> → [команда afterReady / --snapshot] → [кадр --shot]
  При сбое печатает хвост BepInEx\\LogOutput.log.

  python tools/dev_cycle.py                       полный цикл до уровня (readyState из paths.json)
  python tools/dev_cycle.py --until menu          остановиться в меню
  python tools/dev_cycle.py --no-build            только перезапуск
  python tools/dev_cycle.py --build-only          закрыть игру и собрать, не запускать
  python tools/dev_cycle.py --snapshot last       после готовности загрузить снимок (snapshots.load {id})
  python tools/dev_cycle.py --shot after.png      в конце снять кадр (относительно shotsDir)
  python tools/dev_cycle.py --force               убить игру, если не закрылась сама

Команды из paths.json → forbidden (удаление сейвов, сброс прогресса) не отправляются никогда.
Коды выхода: 0 ok · 1 сбой · 2 конфиг · 3 сборка · 4 таймаут.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helper_cli import Api, ApiUnavailable, load_paths, setup_console, short_status, tail_file  # noqa: E402

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
T0 = time.monotonic()


def log(message: str) -> None:
    print(f"[dev_cycle {time.monotonic() - T0:6.1f}s] {message}", flush=True)


def fail(message: str, cfg: dict, code: int = 1) -> int:
    log("СБОЙ: " + message)
    log_file = cfg.get("logFile")
    if log_file:
        errors = [line for line in tail_file(log_file, 400) if re.search(r"Error|Exception|Fatal|BadImageFormat", line)]
        if errors:
            print("---- ошибки в " + log_file + " ----")
            print("\n".join(errors[-25:]))
        print("---- последние строки " + log_file + " ----")
        print("\n".join(tail_file(log_file, 15)))
    return code


# ---------------------------------------------------------------- процессы

def game_pids(exe: str) -> list[int]:
    if not exe:
        return []
    out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {exe}", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW).stdout
    pids = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1 and parts[0].strip('"').lower() == exe.lower():
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    return pids


def wait_exit(exe: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while game_pids(exe) and time.monotonic() < deadline:
        time.sleep(0.5)
    return not game_pids(exe)


# ---------------------------------------------------------------- Steam

def steam_exe(cfg: dict) -> Path | None:
    if cfg.get("steamExe"):
        return Path(cfg["steamExe"])
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _ = winreg.QueryValueEx(key, "SteamExe")
            return Path(value) if value else None
    except OSError:
        return None


def steam_log(cfg: dict) -> Path | None:
    exe = steam_exe(cfg)
    path = exe.parent / "logs" / "gameprocess_log.txt" if exe else None
    return path if path and path.is_file() else None


def wait_steam_release(cfg: dict, since: dt.datetime, timeout: float = 60.0) -> None:
    """После выхода игры Steam ещё держит её «запущенной» (пока живут её потомки).
    Запуск в это время: «игра уже запущена». Ждём 'Remove <appid> from running list' после since."""
    app_id = cfg.get("steamAppId")
    if not app_id:
        return
    path = steam_log(cfg)
    if path is None:
        log("лог Steam не найден — жду 15 с")
        time.sleep(15)
        return
    pattern = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] Remove %s from running list" % re.escape(str(app_id)))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                fh.seek(max(0, path.stat().st_size - 200_000))
                for line in fh.read().splitlines():
                    m = pattern.match(line)
                    if m and dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S") >= since:
                        log("Steam отпустил игру")
                        return
        except OSError:
            pass
        time.sleep(0.5)
    log(f"ВНИМАНИЕ: за {timeout:.0f} с в логе Steam нет 'Remove {app_id} from running list' — запуск может не пройти")


# ---------------------------------------------------------------- шаги

def close_game(cfg: dict, api: Api, force: bool) -> bool:
    exe = cfg.get("exe", "")
    if not game_pids(exe):
        return True
    since = dt.datetime.now().replace(microsecond=0) - dt.timedelta(seconds=2)
    log(f"игра запущена ({exe}) — game.close через API")
    try:
        result = api.act("game.close", timeout=10)
        if not result.get("ok"):
            log("game.close отказ: " + str(result.get("error")))
    except (ApiUnavailable, RuntimeError) as exc:
        log(f"API не ответил ({exc})")
    if not wait_exit(exe, float(cfg.get("closeTimeout", 60))):
        if not force:
            log("игра не закрылась сама; повтори с --force или закрой вручную")
            return False
        log("taskkill /F")
        subprocess.run(["taskkill", "/F", "/IM", exe], capture_output=True, creationflags=NO_WINDOW)
        if not wait_exit(exe, 15):
            return False
    log("процесс игры завершён")
    wait_steam_release(cfg, since)
    return True


def run_cmd(cmd: list[str], cwd: str, what: str) -> bool:
    log(f"{what}: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        interesting = [line for line in out.splitlines() if re.search(r"error|ошибк", line, re.I)]
        print("\n".join(interesting[-30:] or out.splitlines()[-30:]))
        return False
    return True


def clean_env() -> dict:
    # Переменные Doorstop от прошлого запуска игры не должны попасть в новый процесс.
    return {k: v for k, v in os.environ.items() if not k.upper().startswith("DOORSTOP")}


def launch(cfg: dict) -> None:
    mode = cfg.get("launch") or ("steam" if cfg.get("steamAppId") else "exe")
    if mode == "steam":
        if not cfg.get("steamAppId"):
            raise SystemExit("launch=steam, но steamAppId не задан")
        url = f"steam://rungameid/{cfg['steamAppId']}"
        log("запуск через Steam: " + url)
        os.startfile(url)  # type: ignore[attr-defined]
        return
    exe = Path(cfg["gameDir"]) / cfg["exe"]
    if not exe.is_file():
        raise SystemExit(f"нет {exe}")
    log(f"запуск {exe}")
    flags = 0x00000008 | 0x00000200 if os.name == "nt" else 0  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([str(exe)], cwd=str(exe.parent), env=clean_env(), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ---------------------------------------------------------------- main

def main() -> int:
    setup_console()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--paths", help="paths.json (по умолчанию ищется от текущей папки вверх)")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--build-only", action="store_true", help="закрыть игру и собрать, без запуска")
    ap.add_argument("--no-launch", action="store_true", help="не запускать (игра закрыта и пересобрана)")
    ap.add_argument("--no-interop-fix", action="store_true")
    ap.add_argument("--force", action="store_true", help="убить игру, если она не закрылась сама")
    ap.add_argument("--until", help="ждать это состояние (menu|level), по умолчанию readyState")
    ap.add_argument("--timeout", type=float, help="ожидание готовности, с")
    ap.add_argument("--snapshot", metavar="ID|last", help="после готовности: snapshots.load {id}")
    ap.add_argument("--shot", help="в конце снять кадр в файл (относительно shotsDir)")
    ap.add_argument("--shot-width", type=int, default=1280)
    a = ap.parse_args()

    cfg = load_paths(a.paths)
    if not cfg:
        print("нет paths.json: скопируй tools/paths.example.json в paths.json рядом с проектом и заполни", file=sys.stderr)
        return 2
    for key in ("gameDir", "exe", "apiBase"):
        if not cfg.get(key):
            print(f"paths.json: не задан {key}", file=sys.stderr)
            return 2
    api = Api(cfg["apiBase"], cfg.get("forbidden"))
    exe = cfg["exe"]

    if not a.no_launch or not a.no_build:
        if not close_game(cfg, api, a.force):
            return fail("игра не закрылась", cfg)

    if not a.no_build:
        cmd = cfg.get("buildCmd") or ["dotnet", "build", cfg.get("project", ""), "-c", "Release", "-nologo", "-v", "q",
                                      f"-p:GameDir={cfg['gameDir']}", f"-p:GameExe={exe}"]
        if not run_cmd(cmd, cfg["root"], "сборка"):
            return fail("сборка не прошла", cfg, 3)
        log("сборка ок")

    if cfg.get("interopFixCmd") and not a.no_interop_fix:
        if not run_cmd(cfg["interopFixCmd"], cfg["root"], "InteropFix"):
            return fail("InteropFix не прошёл", cfg)

    if a.build_only or a.no_launch:
        return 0

    log_file = cfg.get("logFile")
    log_mtime = Path(log_file).stat().st_mtime if log_file and Path(log_file).is_file() else 0
    launch(cfg)

    want = a.until or cfg.get("readyState") or "level"
    timeout = a.timeout or float(cfg.get("readyTimeout", 180))
    started = time.monotonic()
    seen_process = False

    def alive() -> bool:
        nonlocal seen_process
        running = bool(game_pids(exe))
        seen_process = seen_process or running
        # через Steam процесс появляется не сразу — первые 60 с отсутствие не считается падением
        return running or (not seen_process and time.monotonic() - started < 60)

    def on_change(st):
        log(short_status(st))

    try:
        api.wait_state(want, timeout, on_change=on_change, alive=alive)
    except TimeoutError as exc:
        if log_file and Path(log_file).is_file() and Path(log_file).stat().st_mtime == log_mtime:
            log("LogOutput.log не обновился — BepInEx не стартовал (Doorstop/winhttp.dll? запуск не той копии?)")
        return fail(str(exc), cfg, 4)
    except RuntimeError as exc:
        return fail(str(exc), cfg)
    log(f"готово: connection={want}")

    after = None
    if a.snapshot:
        after = {"command": "snapshots.load", "args": {"id": a.snapshot}, "readyState": "level"}
    elif cfg.get("afterReady"):
        after = cfg["afterReady"]
    if after:
        log(f"{after['command']} {after.get('args') or {}}")
        try:
            result = api.act(after["command"], after.get("args"), timeout=300)
        except (ApiUnavailable, RuntimeError) as exc:
            return fail(str(exc), cfg)
        if not result.get("ok"):
            return fail(f"{after['command']}: {result.get('error')}", cfg)
        try:
            api.wait_state(after.get("readyState", "level"), timeout, on_change=on_change, alive=alive)
        except (TimeoutError, RuntimeError) as exc:
            return fail(str(exc), cfg, 4 if isinstance(exc, TimeoutError) else 1)

    if a.shot:
        time.sleep(1.5)  # дать догрузиться стримингу/теням
        out = Path(a.shot)
        if not out.is_absolute():
            out = Path(cfg.get("shotsDir") or cfg["root"]) / out
        out.parent.mkdir(parents=True, exist_ok=True)
        try:
            data = api.screenshot(a.shot_width, jpg=out.suffix.lower() in (".jpg", ".jpeg"), frames=2)
        except (ApiUnavailable, RuntimeError) as exc:
            return fail("кадр: " + str(exc), cfg)
        out.write_bytes(data)
        log(f"кадр → {out}")

    log(f"цикл завершён за {time.monotonic() - T0:.0f} с")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
