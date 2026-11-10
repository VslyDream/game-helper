#!/usr/bin/env python3
"""CLI агента для адаптера игры: тот же /api, что у панели и MCP. Только stdlib.

  helper_cli.py state [--short]                 состояние (--short: одна строка: подключение, сцена, пауза, скорость)
  helper_cli.py act <command> ['{"json":"args"}']  POST /api/action; код выхода 1 при ok:false
  helper_cli.py cheat <id> <value>              cheat.set {id, value}   (value — JSON: true, 2.5, "x")
  helper_cli.py wait [--state level] [--timeout 180]
  helper_cli.py shot <file.png|jpg> [--w 1280] [--frames 2]
  helper_cli.py log [n] [--grep TEXT]           хвост BepInEx/LogOutput.log (файл читается напрямую — работает и без игры)
  helper_cli.py commands                        GET /api/commands
  helper_cli.py inspect types <query>
  helper_cli.py inspect find [--type T] [--name N] [--limit 30]
  helper_cli.py inspect get <target> [path] [--depth 1] [--methods]
  helper_cli.py inspect set <target> <path> <json-value>
  helper_cli.py inspect invoke <target> <method> ['[json args]'] [--path P]
     target: obj:<id> | go:<имя GameObject> | type:<Тип>; inspect.* — только при [Dev] DevTools=true

Адрес API: --api, переменная GAME_HELPER_API, apiBase из paths.json (ищется от текущей папки вверх
или --paths), иначе http://127.0.0.1:18801. Команды из paths.json → forbidden не отправляются.
Коды выхода: 0 ok · 1 отказ/ошибка · 2 использование · 3 API недоступен · 4 таймаут.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_API = "http://127.0.0.1:18801"


class ApiUnavailable(Exception):
    pass


def setup_console() -> None:
    """Вывод в трубу (агент, | head) — UTF-8, иначе cp1251 падает на «→» и кириллице в JSON."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


# ---------------------------------------------------------------- paths.json

def find_paths(explicit: str | None = None) -> Path | None:
    if explicit:
        return Path(explicit)
    env = os.environ.get("GAME_HELPER_PATHS")
    if env:
        return Path(env)
    here = Path.cwd().resolve()
    for folder in (here, *here.parents):
        candidate = folder / "paths.json"
        if candidate.is_file():
            return candidate
    return None


def load_paths(explicit: str | None = None) -> dict:
    """paths.json → dict с раскрытыми подстановками и абсолютными путями. Нет файла — пустой dict."""
    path = find_paths(explicit)
    if path is None:
        return {}
    if not path.is_file():
        raise SystemExit(f"нет файла {path}")
    with path.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    root = path.resolve().parent
    cfg = {k: v for k, v in raw.items() if not k.startswith("_")}
    cfg["root"] = str(root)

    def absolute(value: str) -> str:
        p = Path(value)
        return str(p if p.is_absolute() else (root / p).resolve())

    for key in ("gameDir", "project"):
        if cfg.get(key):
            cfg[key] = absolute(cfg[key])

    def expand(value):
        if isinstance(value, str):
            for key in ("gameDir", "exe", "project", "root"):
                value = value.replace("{" + key + "}", str(cfg.get(key) or ""))
            return value
        if isinstance(value, list):
            return [expand(v) for v in value]
        if isinstance(value, dict):
            return {k: expand(v) for k, v in value.items()}
        return value

    for key, value in list(cfg.items()):
        if key not in ("gameDir", "project", "root"):
            cfg[key] = expand(value)
    for key in ("logFile", "shotsDir"):
        if cfg.get(key):
            cfg[key] = absolute(cfg[key])
    cfg["_file"] = str(path.resolve())
    return cfg


# ---------------------------------------------------------------- API

class Api:
    def __init__(self, base: str, forbidden: list[str] | None = None):
        self.base = base.rstrip("/")
        self.forbidden = set(forbidden or [])

    def _request(self, path: str, body: dict | None = None, timeout: float = 30.0) -> bytes:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base + path, data=data, method="GET" if body is None else "POST")
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            try:
                message = json.loads(payload).get("error") or payload.decode("utf-8", "replace")
            except (ValueError, AttributeError):
                message = payload.decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {exc.code}: {message}") from None
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
            raise ApiUnavailable(f"API {self.base} недоступен: {getattr(exc, 'reason', exc)}") from None

    def get_json(self, path: str, timeout: float = 15.0):
        return json.loads(self._request(path, timeout=timeout))

    def state(self, timeout: float = 10.0) -> dict:
        return self.get_json("/api/state", timeout)

    def is_up(self) -> bool:
        try:
            self.state(timeout=2.0)
            return True
        except (ApiUnavailable, RuntimeError, ValueError):
            return False

    def act(self, command: str, args: dict | None = None, timeout: float = 120.0) -> dict:
        if command in self.forbidden:
            raise SystemExit(f"команда {command} в списке forbidden (paths.json) — агент её не отправляет")
        body = {"id": uuid.uuid4().hex, "command": command, "args": args or {}}
        return json.loads(self._request("/api/action", body, timeout))

    def screenshot(self, width: int = 0, jpg: bool = False, frames: int = 1, timeout: float = 30.0) -> bytes:
        query = f"?w={width}&frames={frames}" + ("&fmt=jpg" if jpg else "")
        return self._request("/api/screenshot" + query, timeout=timeout)

    def wait_state(self, want: str, timeout: float, on_change=None, alive=None) -> dict:
        """Ждать connection == want и operation == null. alive() → False прерывает (процесс игры умер)."""
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                st = self.state(timeout=5.0)
                key = (st.get("connection"), json.dumps(st.get("operation"), ensure_ascii=False))
                if key != last and on_change:
                    on_change(st)
                last = key
                if st.get("connection") == want and not st.get("operation"):
                    return st
            except (ApiUnavailable, RuntimeError, ValueError):
                if last != "down" and on_change:
                    on_change(None)
                last = "down"
            if alive is not None and not alive():
                raise RuntimeError("процесс игры завершился")
            time.sleep(1.0)
        raise TimeoutError(f"за {timeout:.0f} с не дождался connection={want}")


def short_status(st: dict | None) -> str:
    """MCP-05: всегда видно подключение, сцену, паузу и скорость."""
    if not st:
        return "API недоступен"
    parts = [f"connection={st.get('connection')}", f"scene={st.get('scene', '?')}"]
    if st.get("paused"):
        parts.append("ПАУЗА")
    if "timeScale" in st:
        parts.append(f"timeScale={st.get('timeScale')}")
    op = st.get("operation")
    if op:
        parts.append(f"operation={op.get('stage') or ''} {op.get('message') or ''}".strip())
    return " | ".join(parts)


def tail_file(path: str | Path, n: int = 100, grep: str | None = None) -> list[str]:
    path = Path(path)
    if not path.is_file():
        return [f"(нет файла {path})"]
    with path.open("rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - 1_000_000))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    if grep:
        lines = [line for line in lines if grep.lower() in line.lower()]
    return lines[-n:]


def dump(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def parse_json_arg(text: str | None, what: str):
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        raise SystemExit(f"{what}: не JSON: {text}") from None


# ---------------------------------------------------------------- CLI

def main(argv: list[str] | None = None) -> int:
    setup_console()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", help="адрес API адаптера")
    ap.add_argument("--paths", help="путь к paths.json")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("state")
    p.add_argument("--short", action="store_true")
    p = sub.add_parser("act")
    p.add_argument("command")
    p.add_argument("args", nargs="?")
    p = sub.add_parser("cheat")
    p.add_argument("id")
    p.add_argument("value")
    p = sub.add_parser("wait")
    p.add_argument("--state", default="level")
    p.add_argument("--timeout", type=float, default=180)
    p = sub.add_parser("shot")
    p.add_argument("file")
    p.add_argument("--w", type=int, default=1280, help="ширина (0 — полный размер)")
    p.add_argument("--frames", type=int, default=1)
    p = sub.add_parser("log")
    p.add_argument("n", nargs="?", type=int, default=60)
    p.add_argument("--grep")
    sub.add_parser("commands")

    ins = sub.add_parser("inspect").add_subparsers(dest="what", required=True)
    p = ins.add_parser("types")
    p.add_argument("query")
    p = ins.add_parser("find")
    p.add_argument("--type")
    p.add_argument("--name")
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--assets", action="store_true")
    p = ins.add_parser("get")
    p.add_argument("target")
    p.add_argument("path", nargs="?")
    p.add_argument("--depth", type=int, default=1)
    p.add_argument("--methods", action="store_true")
    p = ins.add_parser("set")
    p.add_argument("target")
    p.add_argument("path")
    p.add_argument("value")
    p = ins.add_parser("invoke")
    p.add_argument("target")
    p.add_argument("method")
    p.add_argument("args", nargs="?")
    p.add_argument("--path")

    a = ap.parse_args(argv)
    cfg = load_paths(a.paths)
    api = Api(a.api or os.environ.get("GAME_HELPER_API") or cfg.get("apiBase") or DEFAULT_API, cfg.get("forbidden"))

    def action(command: str, args: dict | None) -> int:
        result = api.act(command, args)
        if not result.get("ok"):
            print("ОТКАЗ: " + str(result.get("error")), file=sys.stderr)
            return 1
        out = {"ok": True}
        if "result" in result:
            out["result"] = result["result"]
        out["status"] = short_status(result.get("state"))
        dump(out)
        return 0

    try:
        if a.cmd == "state":
            st = api.state()
            print(short_status(st)) if a.short else dump(st)
            return 0
        if a.cmd == "act":
            args = parse_json_arg(a.args, "args") or {}
            return action(a.command, args)
        if a.cmd == "cheat":
            return action("cheat.set", {"id": a.id, "value": parse_json_arg(a.value, "value")})
        if a.cmd == "wait":
            st = api.wait_state(a.state, a.timeout, on_change=lambda s: print(short_status(s), file=sys.stderr))
            print(short_status(st))
            return 0
        if a.cmd == "shot":
            data = api.screenshot(a.w, jpg=a.file.lower().endswith((".jpg", ".jpeg")), frames=a.frames)
            out = Path(a.file)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            print(f"{out} ({len(data) // 1024} КБ)")
            return 0
        if a.cmd == "log":
            log_file = cfg.get("logFile") or (Path(cfg["gameDir"]) / "BepInEx" / "LogOutput.log" if cfg.get("gameDir") else None)
            if log_file:
                print("\n".join(tail_file(log_file, a.n, a.grep)))
                return 0
            return action("log.tail", {"n": a.n, "grep": a.grep})
        if a.cmd == "commands":
            dump(api.get_json("/api/commands"))
            return 0
        if a.cmd == "inspect":
            if a.what == "types":
                return action("inspect.types", {"query": a.query})
            if a.what == "find":
                return action("inspect.find", {"type": a.type, "name": a.name, "limit": a.limit, "assets": a.assets})
            if a.what == "get":
                return action("inspect.get", {"target": a.target, "path": a.path, "depth": a.depth, "methods": a.methods})
            if a.what == "set":
                return action("inspect.set", {"target": a.target, "path": a.path, "value": parse_json_arg(a.value, "value")})
            if a.what == "invoke":
                return action("inspect.invoke", {"target": a.target, "method": a.method, "path": a.path,
                                                 "args": parse_json_arg(a.args, "args") or []})
    except ApiUnavailable as exc:
        print(str(exc) + " — игра не запущена или плагин не загрузился (helper_cli.py log)", file=sys.stderr)
        return 3
    except TimeoutError as exc:
        print("ТАЙМАУТ: " + str(exc), file=sys.stderr)
        return 4
    except RuntimeError as exc:
        print("ОШИБКА: " + str(exc), file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
