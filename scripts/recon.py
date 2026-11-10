#!/usr/bin/env python3
"""Первичная разведка установленной игры (только чтение папки игры).

Использование:
    python scripts/recon.py "<папка игры>" [--json] [--hash] [--out docs/MODDING_PLAN.md] [--force]

Определяет движок (Unity / Unreal / Godot / прочее), бэкенд Unity (Mono / IL2CPP),
версии Unity и global-metadata, папку BackUpThisFolder, app.info и путь к Player.log,
известные библиотеки, установленные загрузчики модов, признаки античита, Steam appid,
и предлагает маршрут. Только стандартная библиотека, Python 3.9+.

В папку игры ничего не пишет. --out создаёт MODDING_PLAN.md по шаблону
templates/docs/MODDING_PLAN.md (секции «Стек» и «Маршрут»), существующий файл
не перезаписывает без --force.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import struct
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

TOOL_VERSION = 1
KIT_ROOT = Path(__file__).resolve().parent.parent
PLAN_TEMPLATE = KIT_ROOT / "templates" / "docs" / "MODDING_PLAN.md"

METADATA_MAGIC = 0xFAB11BAF
CHUNK = 8 * 1024 * 1024
OVERLAP = 512
MAX_WALK_DEPTH = 3
MAX_WALK_ENTRIES = 20000

PLAYBOOKS = {
    "detect": "references/engines/unity-detect.md",
    "il2cpp": "references/engines/unity-il2cpp-bepinex6.md",
    "mono": "references/engines/unity-mono-bepinex5.md",
    "unreal": "references/engines/unreal-ue4ss.md",
}

UNITY_VERSION_RE = re.compile(rb"(?:5|20\d\d|6000)\.\d+\.\d+[abfpx]\d+")
UNITY_VERSION_STR_RE = re.compile(r"(?:5|20\d\d|6000)\.\d+\.\d+[abfpx]\d+")
UE_ASCII_RE = re.compile(rb"\+\+UE([45])\+Release-(\d+\.\d+)")
UE_WIDE_RE = re.compile(
    rb"\+\x00\+\x00U\x00E\x00([45])\x00\+\x00R\x00e\x00l\x00e\x00a\x00s\x00e\x00-\x00"
    rb"((?:\d\x00)+)\.\x00((?:\d\x00)+)"
)
VERSION_VALUE_RE = re.compile(r"^[0-9][0-9A-Za-z.\-+ ()_,]{0,120}$")

# Не основной exe игры: служебные, установщики, лаунчеры античита.
EXE_NOISE_RE = re.compile(
    r"(unitycrashhandler|crashreport|crashpad|unins\d*|vc_?redist|dxsetup|dotnet|prereq|"
    r"easyanticheat|start_protected_game|beservice|battleye|_be$|cleanup|redist|setup|installer|"
    r"ue4ss|melonloader|uninstall)",
    re.I,
)

# id -> (показываемое имя, имена DLL/сборок, доп. строки для поиска в metadata/коде)
LIBRARIES: List[Tuple[str, str, Tuple[str, ...], Tuple[str, ...]]] = [
    ("cinemachine", "Cinemachine", ("Cinemachine", "Unity.Cinemachine"), ()),
    ("inputsystem", "Unity.InputSystem", ("Unity.InputSystem",), ()),
    ("urp", "URP", ("Unity.RenderPipelines.Universal.Runtime",), ()),
    ("hdrp", "HDRP", ("Unity.RenderPipelines.HighDefinition.Runtime",), ()),
    ("postprocessing", "PostProcessing v2", ("Unity.Postprocessing.Runtime",), ()),
    ("zenject", "Zenject", ("Zenject", "Zenject-usage"), ()),
    ("vcontainer", "VContainer", ("VContainer",), ()),
    ("mirror", "Mirror", ("Mirror",), ()),
    ("fishnet", "FishNet", ("FishNet.Runtime",), ()),
    ("netcode", "Unity.Netcode", ("Unity.Netcode.Runtime",), ()),
    ("photon", "Photon", ("PhotonUnityNetworking", "PhotonRealtime", "Photon3Unity3D", "Fusion.Runtime"), ()),
    ("rewired", "Rewired", ("Rewired_Core",), ()),
    ("es3", "Easy Save 3", ("ES3", "EasySave3"), ("ES3Settings",)),
    ("addressables", "Addressables", ("Unity.Addressables",), ()),
    ("entities", "Unity.Entities (DOTS)", ("Unity.Entities",), ()),
    ("dotween", "DOTween", ("DOTween",), ()),
    ("timeline", "Timeline", ("Unity.Timeline",), ()),
    ("steamworks", "Steamworks.NET/Facepunch", ("com.rlabrecque.steamworks.net", "Facepunch.Steamworks.Win64"), ()),
    ("fmod", "FMOD", ("FMODUnity",), ()),
]

ANTICHEAT_DIRS = {
    "easyanticheat": "EasyAntiCheat",
    "battleye": "BattlEye",
    "gameguard": "nProtect GameGuard",
    "xigncode": "XIGNCODE3",
}
ANTICHEAT_FILES = [
    (re.compile(r"^easyanticheat.*\.(dll|exe|sys)$", re.I), "EasyAntiCheat"),
    (re.compile(r"^start_protected_game\.exe$", re.I), "EasyAntiCheat"),
    (re.compile(r"^beclient(_x64)?\.dll$", re.I), "BattlEye"),
    (re.compile(r"^beservice(_x64)?\.exe$", re.I), "BattlEye"),
    (re.compile(r"_be\.exe$", re.I), "BattlEye"),
]

PROXY_DLLS = ("winhttp.dll", "version.dll", "dwmapi.dll", "winmm.dll", "dinput8.dll", "xinput1_3.dll", "d3d11.dll")


# ---------------------------------------------------------------- низкоуровневые помощники

def _read_head(path: Path, size: int) -> bytes:
    try:
        with path.open("rb") as fh:
            return fh.read(size)
    except OSError:
        return b""


def _iter_chunks(path: Path, max_bytes: Optional[int] = None, from_end: bool = False):
    """Читает файл кусками с перекрытием. from_end — с конца (ресурсы PE обычно в конце)."""
    try:
        size = path.stat().st_size
    except OSError:
        return
    limit = size if max_bytes is None else min(size, max_bytes)
    try:
        with path.open("rb") as fh:
            if from_end:
                pos = size
                stop = size - limit
                while pos > stop:
                    start = max(stop, pos - CHUNK)
                    fh.seek(start)
                    yield fh.read(min(size, pos + OVERLAP) - start)
                    pos = start
            else:
                pos = 0
                while pos < limit:
                    fh.seek(pos)
                    yield fh.read(min(CHUNK + OVERLAP, limit - pos))
                    pos += CHUNK
    except OSError:
        return


def find_needles(path: Path, needles: Iterable[bytes], max_bytes: int = 512 * 1024 * 1024) -> set:
    """Какие из байтовых строк встречаются в файле (ограниченный поиск)."""
    left = set(needles)
    found = set()
    for chunk in _iter_chunks(path, max_bytes):
        for n in list(left):
            if n in chunk:
                found.add(n)
                left.discard(n)
        if not left:
            break
    return found


def scan_regex(path: Path, regex: "re.Pattern[bytes]", max_bytes: Optional[int] = None,
               from_end: bool = False) -> Optional["re.Match[bytes]"]:
    for chunk in _iter_chunks(path, max_bytes, from_end):
        m = regex.search(chunk)
        if m:
            return m
    return None


def pe_version(path: Path, keys: Tuple[str, ...] = ("ProductVersion", "FileVersion")) -> Optional[str]:
    """Строка из VS_VERSION_INFO без разбора PE: ищем UTF-16 ключ и читаем значение за ним."""
    if not path.is_file():
        return None
    for key in keys:
        needle = key.encode("utf-16-le") + b"\x00\x00"
        for chunk in _iter_chunks(path, from_end=True):
            idx = chunk.find(needle)
            while idx != -1:
                value = _read_wide_value(chunk, idx + len(needle))
                if value and VERSION_VALUE_RE.match(value):
                    return value.strip()
                idx = chunk.find(needle, idx + 2)
    return None


def _read_wide_value(buf: bytes, pos: int) -> Optional[str]:
    # пропустить выравнивающие нули (парами)
    while pos + 1 < len(buf) and buf[pos:pos + 2] == b"\x00\x00":
        pos += 2
    end = pos
    while end + 1 < len(buf) and buf[end:end + 2] != b"\x00\x00" and end - pos < 256:
        end += 2
    if end == pos:
        return None
    try:
        return buf[pos:end].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def sha256(path: Path) -> Optional[str]:
    h = hashlib.sha256()
    try:
        with path.open("rb") as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b""):
                h.update(block)
    except OSError:
        return None
    return h.hexdigest()


def walk_limited(root: Path, depth: int = MAX_WALK_DEPTH):
    """(путь, is_dir) до заданной глубины, с ограничением числа записей."""
    count = 0
    stack = [(root, 0)]
    while stack:
        cur, d = stack.pop()
        try:
            entries = list(os.scandir(cur))
        except OSError:
            continue
        for e in entries:
            count += 1
            if count > MAX_WALK_ENTRIES:
                return
            p = Path(e.path)
            try:
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            yield p, is_dir
            if is_dir and d + 1 < depth:
                stack.append((p, d + 1))


def rel(p: Optional[Path], root: Path) -> Optional[str]:
    if p is None:
        return None
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def _ci_child(parent: Path, name: str) -> Optional[Path]:
    """Дочерний элемент без учёта регистра."""
    p = parent / name
    if p.exists():
        return p
    try:
        low = name.lower()
        for e in os.scandir(parent):
            if e.name.lower() == low:
                return Path(e.path)
    except OSError:
        pass
    return None


# ---------------------------------------------------------------- обнаружение

class Recon:
    def __init__(self, game_dir: Path, do_hash: bool = False, home: Optional[Path] = None):
        self.root = game_dir.resolve()
        self.do_hash = do_hash
        self.home = home or Path(os.environ.get("USERPROFILE") or Path.home())
        self.warnings: List[str] = []
        self.r: Dict = {
            "tool": "recon",
            "toolVersion": TOOL_VERSION,
            "gameDir": str(self.root),
            "engine": "unknown",
            "engineHint": None,
            "engineVersion": None,
            "backend": None,
            "unityVersion": None,
            "unityVersionSource": None,
            "metadataVersion": None,
            "exe": [],
            "dataDir": None,
            "developmentBuild": None,
            "backupManaged": None,
            "appInfo": None,
            "playerLog": None,
            "libraries": [],
            "loaders": [],
            "antiCheat": [],
            "steamAppId": None,
            "steamBuildId": None,
            "route": None,
            "warnings": self.warnings,
            "hashes": {},
        }
        self.entries = list(walk_limited(self.root))

    # -- exe

    def _exes(self) -> List[Path]:
        top = [p for p in self.root.glob("*.exe") if p.is_file()]
        shipping = [p for p, d in self.entries if not d and p.name.lower().endswith("-win64-shipping.exe")]
        if not shipping:
            # Unreal: <Project>/Binaries/Win64 бывает глубже лимита обхода
            shipping = [p for p in self.root.glob("*/Binaries/Win64/*-Win64-Shipping.exe")]
        return top + [p for p in shipping if p not in top]

    def run(self) -> Dict:
        exes = self._exes()
        data_dirs = sorted(p for p in self.root.glob("*_Data") if p.is_dir())
        unity_player = _ci_child(self.root, "UnityPlayer.dll")
        if unity_player or any(self._is_unity_data(d) for d in data_dirs):
            self._unity(exes, data_dirs, unity_player)
        elif self._is_unreal(exes):
            self._unreal(exes)
        elif self._is_godot(exes):
            self._godot(exes)
        else:
            self._other(exes)
        self._loaders()
        self._anticheat()
        self._steam()
        if self.do_hash:
            self._hashes()
        self.r["route"] = self._route()
        return self.r

    def _order_exes(self, exes: List[Path], prefer: Optional[Path] = None) -> None:
        def key(p: Path):
            noise = bool(EXE_NOISE_RE.search(p.stem))
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            return (p != prefer, noise, -size, p.name.lower())
        self.r["exe"] = [rel(p, self.root) for p in sorted(exes, key=key)]
        if not exes:
            self.warnings.append("exe не найден в корне папки: проверьте, что указана папка установки игры")

    # -- Unity

    @staticmethod
    def _is_unity_data(d: Path) -> bool:
        return any((d / n).exists() for n in ("globalgamemanagers", "data.unity3d", "Managed", "il2cpp_data", "mainData"))

    def _unity(self, exes: List[Path], data_dirs: List[Path], unity_player: Optional[Path]) -> None:
        r = self.r
        r["engine"] = "unity"
        data = None
        main = None
        for e in exes:
            cand = self.root / (e.stem + "_Data")
            if cand.is_dir():
                data, main = cand, e
                break
        if data is None and data_dirs:
            data = data_dirs[0]
        if len([d for d in data_dirs if self._is_unity_data(d)]) > 1:
            self.warnings.append("несколько папок *_Data: проверьте, какая относится к основному exe")
        self._order_exes(exes, main)
        r["dataDir"] = rel(data, self.root)

        game_assembly = _ci_child(self.root, "GameAssembly.dll")
        metadata = data / "il2cpp_data" / "Metadata" / "global-metadata.dat" if data else None
        managed = data / "Managed" if data else None
        if game_assembly or (metadata and metadata.is_file()):
            r["backend"] = "il2cpp"
            if metadata and metadata.is_file():
                head = _read_head(metadata, 8)
                if len(head) == 8:
                    magic, ver = struct.unpack("<Ii", head)
                    if magic == METADATA_MAGIC:
                        r["metadataVersion"] = ver
                    else:
                        self.warnings.append(
                            "global-metadata.dat без стандартной сигнатуры 0xFAB11BAF: зашифрован/обфусцирован, "
                            "обычный дампер не сработает")
            else:
                self.warnings.append("IL2CPP без global-metadata.dat на обычном месте: возможно встроен в GameAssembly.dll или зашифрован")
        elif (managed and (managed / "Assembly-CSharp.dll").is_file()) or _ci_child(self.root, "MonoBleedingEdge"):
            r["backend"] = "mono"
        else:
            self.warnings.append("бэкенд Unity не определён (нет GameAssembly.dll и Managed/Assembly-CSharp.dll)")

        self._unity_version(data, unity_player, main)
        if data:
            self._boot_config(data)
            self._app_info(data)
        self._backup()
        self._libraries(data, metadata)

    def _unity_version(self, data: Optional[Path], unity_player: Optional[Path], main: Optional[Path]) -> None:
        if data:
            for name in ("globalgamemanagers", "data.unity3d", "level0", "mainData"):
                p = data / name
                if p.is_file():
                    m = UNITY_VERSION_RE.search(_read_head(p, 4096))
                    if m:
                        self.r["unityVersion"] = m.group(0).decode("ascii")
                        self.r["unityVersionSource"] = rel(p, self.root)
                        return
        for exe_like in (unity_player, main):
            if exe_like and exe_like.is_file():
                v = pe_version(exe_like)
                if v:
                    m = UNITY_VERSION_STR_RE.search(v)
                    if m:
                        self.r["unityVersion"] = m.group(0)
                        self.r["unityVersionSource"] = rel(exe_like, self.root) + " (ProductVersion)"
                        return
        self.warnings.append("версия Unity не найдена: посмотреть первую строку Player.log после запуска")

    def _boot_config(self, data: Path) -> None:
        boot = data / "boot.config"
        dev = None
        if boot.is_file():
            text = _read_head(boot, 64 * 1024).decode("utf-8", "replace")
            dev = "player-connection" in text
        if _ci_child(self.root, "WinPixEventRuntime.dll"):
            dev = True
        self.r["developmentBuild"] = dev

    def _app_info(self, data: Path) -> None:
        p = data / "app.info"
        if not p.is_file():
            return
        lines = [ln.strip() for ln in _read_head(p, 4096).decode("utf-8-sig", "replace").splitlines()]
        lines = [ln for ln in lines if ln]
        if len(lines) < 2:
            return
        company, product = lines[0], lines[1]
        self.r["appInfo"] = {"company": company, "product": product}
        folder = self.home / "AppData" / "LocalLow" / company / product
        log = folder / "Player.log"
        self.r["playerLog"] = {"path": str(log), "exists": log.is_file(), "dataFolder": str(folder),
                               "dataFolderExists": folder.is_dir()}

    def _backup(self) -> None:
        for d in self.root.glob("*_BackUpThisFolder_ButDontShipItWithYourGame"):
            if not d.is_dir():
                continue
            managed = d / "Managed"
            dlls = sorted(managed.glob("*.dll")) if managed.is_dir() else []
            pdbs = list(managed.glob("*.pdb")) if managed.is_dir() else []
            self.r["backupManaged"] = {
                "path": rel(d, self.root),
                "managedDir": rel(managed, self.root) if managed.is_dir() else None,
                "managedDlls": len(dlls),
                "pdbs": len(pdbs),
                "hasAssemblyCSharp": (managed / "Assembly-CSharp.dll").is_file(),
                "gameAssemblyPdb": any(p.name.lower() == "gameassembly.pdb" for p in d.rglob("*.pdb")),
            }
            return

    def _libraries(self, data: Optional[Path], metadata: Optional[Path]) -> None:
        found: Dict[str, str] = {}
        stems: Dict[str, str] = {}
        dirs = []
        if data:
            dirs += [data / "Managed", data / "Plugins", data / "Plugins" / "x86_64"]
        bm = self.r["backupManaged"]
        if bm and bm.get("managedDir"):
            dirs.append(self.root / bm["managedDir"])
        for d in dirs:
            if d.is_dir():
                for f in d.glob("*.dll"):
                    stems.setdefault(f.stem.lower(), rel(d, self.root))
        # ScriptingAssemblies.json перечисляет сборки и в IL2CPP
        sa = data / "ScriptingAssemblies.json" if data else None
        sa_names = set()
        if sa and sa.is_file():
            try:
                obj = json.loads(sa.read_text(encoding="utf-8-sig"))
                sa_names = {Path(n).stem.lower() for n in obj.get("names", [])}
            except (OSError, ValueError, AttributeError):
                pass
        for lid, label, dll_names, _ in LIBRARIES:
            for n in dll_names:
                if n.lower() in stems:
                    found[lid] = stems[n.lower()]
                    break
                if n.lower() in sa_names:
                    found[lid] = rel(sa, self.root)
                    break
        lid_missing = [x for x in LIBRARIES if x[0] not in found]
        if lid_missing:
            needles: Dict[bytes, str] = {}
            for lid, _, dll_names, extra in lid_missing:
                for n in dll_names:
                    needles[b"\x00" + n.encode() + b".dll\x00"] = lid
                for s in extra:
                    needles[b"\x00" + s.encode() + b"\x00"] = lid
            targets: List[Path] = []
            if metadata and metadata.is_file() and self.r["metadataVersion"] is not None:
                targets.append(metadata)
            if data:
                for n in ("Assembly-CSharp.dll", "Assembly-CSharp-firstpass.dll"):
                    p = data / "Managed" / n
                    if p.is_file():
                        targets.append(p)
            for t in targets:
                for n in find_needles(t, needles.keys()):
                    found.setdefault(needles[n], rel(t, self.root))
        if (_ci_child(self.root, "steam_api64.dll") or (data and (data / "Plugins" / "x86_64" / "steam_api64.dll").is_file())):
            found.setdefault("steamworks", "steam_api64.dll")
        if data and any((data / "Plugins" / "x86_64").glob("fmod*.dll")):
            found.setdefault("fmod", rel(data / "Plugins" / "x86_64", self.root))
        labels = {lid: label for lid, label, _, _ in LIBRARIES}
        self.r["libraries"] = [{"id": lid, "name": labels[lid], "source": found[lid]}
                               for lid, *_ in LIBRARIES if lid in found]

    # -- Unreal

    def _is_unreal(self, exes: List[Path]) -> bool:
        if any(p.name.lower().endswith("-win64-shipping.exe") for p in exes):
            return True
        if (self.root / "Engine").is_dir() and (any(self.root.glob("*/Binaries")) or any(self.root.glob("*/Content/Paks"))):
            return True
        return any(p.suffix.lower() in (".pak", ".utoc") for p, d in self.entries if not d)

    def _unreal(self, exes: List[Path]) -> None:
        r = self.r
        r["engine"] = "unreal"
        shipping = [p for p in exes if p.name.lower().endswith("-win64-shipping.exe")]
        self._order_exes(exes, shipping[0] if shipping else None)
        # <Project>/Content/Paks глубже общего лимита обхода — смотрим отдельно
        pak_files = {p for p, d in self.entries if not d} | set(self.root.glob("*/Content/Paks/**/*"))
        paks = [p for p in pak_files if p.suffix.lower() == ".pak"]
        iostore = any(p.suffix.lower() == ".utoc" for p in pak_files)
        project = None
        if shipping:
            project = shipping[0].parent.parent.parent  # <Project>/Binaries/Win64/x.exe
            r["dataDir"] = rel(project, self.root)
            m = scan_regex(shipping[0], UE_WIDE_RE, max_bytes=768 * 1024 * 1024)
            if m:
                r["engineVersion"] = "{}.{}".format(m.group(2).replace(b"\x00", b"").decode(),
                                                     m.group(3).replace(b"\x00", b"").decode())
            else:
                m = scan_regex(shipping[0], UE_ASCII_RE, max_bytes=768 * 1024 * 1024)
                if m:
                    r["engineVersion"] = m.group(2).decode()
            if not r["engineVersion"]:
                v = pe_version(shipping[0])
                if v:
                    r["engineHint"] = "версия exe: " + v
        else:
            self.warnings.append("Unreal: *-Win64-Shipping.exe не найден, версию движка взять из лога игры")
        r["engineHint"] = ((r["engineHint"] + "; ") if r["engineHint"] else "") + \
            "pak: {}{}".format(len(paks), ", IoStore (.utoc/.ucas)" if iostore else "")
        if project is not None:
            name = project.name
            local = Path(os.environ.get("LOCALAPPDATA") or (self.home / "AppData" / "Local"))
            log = local / name / "Saved" / "Logs" / (name + ".log")
            r["playerLog"] = {"path": str(log), "exists": log.is_file(),
                              "dataFolder": str(local / name / "Saved"),
                              "dataFolderExists": (local / name / "Saved").is_dir()}

    # -- Godot

    def _is_godot(self, exes: List[Path]) -> bool:
        if any(self.root.glob("*.pck")):
            return True
        for e in exes:
            try:
                size = e.stat().st_size
                with e.open("rb") as fh:
                    fh.seek(max(0, size - 4))
                    if fh.read(4) == b"GDPC":
                        return True
            except OSError:
                pass
        return False

    def _godot(self, exes: List[Path]) -> None:
        r = self.r
        r["engine"] = "godot"
        pcks = sorted(self.root.glob("*.pck"))
        main = None
        for e in exes:
            if pcks and e.stem == pcks[0].stem:
                main = e
        self._order_exes(exes, main)
        if pcks:
            r["dataDir"] = rel(pcks[0], self.root)
            head = _read_head(pcks[0], 20)
            if len(head) >= 20 and head[:4] == b"GDPC":
                fmt, major, minor, patch = struct.unpack("<4I", head[4:20])
                r["engineVersion"] = "{}.{}.{}".format(major, minor, patch)
                r["engineHint"] = "pck format {}".format(fmt)
            elif head[:4] != b"GDPC":
                self.warnings.append("pck без сигнатуры GDPC: возможно зашифрован")
        else:
            r["engineHint"] = "pck встроен в exe"
        if any(self.root.glob("data_*/GodotSharp.dll")):
            r["backend"] = "csharp"

    # -- прочее

    def _other(self, exes: List[Path]) -> None:
        r = self.r
        self._order_exes(exes)
        hints = [
            ("data.win", "GameMaker"),
            ("renpy", "Ren'Py"),
            ("www/js/rpg_core.js", "RPG Maker MV"),
            ("js/rmmz_core.js", "RPG Maker MZ"),
            ("package.nw", "NW.js"),
            ("resources/app.asar", "Electron"),
        ]
        for path, name in hints:
            if (self.root / path).exists():
                r["engine"] = "other"
                r["engineHint"] = name
                return
        if any(p.suffix.lower() == ".vpk" for p, d in self.entries if not d):
            r["engine"] = "other"
            r["engineHint"] = "Source (vpk)"
            return
        r["engine"] = "unknown"

    # -- загрузчики

    def _loader_dirs(self) -> List[Path]:
        dirs = [self.root]
        for e in self.r["exe"]:
            p = (self.root / e).parent
            if p not in dirs:
                dirs.append(p)
        return dirs

    def _loaders(self) -> None:
        loaders = self.r["loaders"]
        bep = _ci_child(self.root, "BepInEx")
        if bep and bep.is_dir():
            core = bep / "core"
            version = pe_version(core / "BepInEx.Core.dll") or pe_version(core / "BepInEx.dll")
            if not version:
                ch = _ci_child(self.root, "changelog.txt")
                if ch:
                    m = re.search(r"\d+\.\d+\.\d+(?:[.\-][\w.+]+)?", _read_head(ch, 2048).decode("utf-8", "replace"))
                    version = m.group(0) if m else None
            if (core / "BepInEx.Unity.IL2CPP.dll").is_file() or (core / "BepInEx.IL2CPP.dll").is_file():
                flavor = "IL2CPP"
            elif (core / "BepInEx.Unity.Mono.dll").is_file():
                flavor = "Mono (BepInEx 6)"
            elif (core / "BepInEx.dll").is_file():
                flavor = "Mono (BepInEx 5)"
            else:
                flavor = None
            plugins = bep / "plugins"
            interop = bep / "interop"
            details = {
                "flavor": flavor,
                "plugins": len(list(plugins.rglob("*.dll"))) if plugins.is_dir() else 0,
                "interopDlls": len(list(interop.glob("*.dll"))) if interop.is_dir() else 0,
                "config": (bep / "config" / "BepInEx.cfg").is_file(),
                "logOutput": (bep / "LogOutput.log").is_file(),
            }
            loaders.append({"name": "BepInEx", "version": version, "path": rel(bep, self.root), "details": details})
            backend = self.r.get("backend")
            if flavor == "IL2CPP" and backend == "mono":
                self.warnings.append("BepInEx IL2CPP-сборка стоит на Mono-игре: нужна другая сборка")
            if flavor and flavor.startswith("Mono") and backend == "il2cpp":
                self.warnings.append("Mono-сборка BepInEx стоит на IL2CPP-игре: нужна BepInEx 6 IL2CPP")

        ml = _ci_child(self.root, "MelonLoader")
        if ml and ml.is_dir():
            v = None
            for cand in ("net6/MelonLoader.dll", "net35/MelonLoader.dll", "MelonLoader.dll"):
                v = pe_version(ml / cand)
                if v:
                    break
            loaders.append({"name": "MelonLoader", "version": v, "path": rel(ml, self.root), "details": {}})

        for d in self._loader_dirs():
            ue = None
            for cand in ("ue4ss/UE4SS.dll", "UE4SS.dll"):
                if (d / cand).is_file():
                    ue = d / cand
                    break
            if ue:
                loaders.append({"name": "UE4SS", "version": pe_version(ue), "path": rel(ue.parent, self.root),
                                "details": {"settings": any(ue.parent.glob("UE4SS-settings.ini"))}})

        doorstop_cfg = None
        for d in self._loader_dirs():
            for name in PROXY_DLLS:
                p = _ci_child(d, name)
                disabled = _ci_child(d, name + ".disabled")
                if not p and not disabled:
                    continue
                cfg = _ci_child(d, "doorstop_config.ini")
                ver_file = _ci_child(d, ".doorstop_version")
                if cfg or ver_file:
                    owner = "Doorstop"
                    doorstop_cfg = cfg
                elif name == "version.dll" and ml:
                    owner = "MelonLoader proxy"
                elif name in ("dwmapi.dll", "xinput1_3.dll") and any(x["name"] == "UE4SS" for x in loaders):
                    owner = "UE4SS proxy"
                else:
                    owner = "proxy DLL (чей — неизвестно)"
                version = _read_head(ver_file, 64).decode("utf-8", "replace").strip() if ver_file else None
                loaders.append({
                    "name": owner, "version": version or None, "path": rel(p or disabled, self.root),
                    "details": {"proxy": name, "disabled": bool(disabled and not p)},
                })
                if disabled and not p:
                    self.warnings.append("{} переименован в .disabled: загрузчик выключен".format(name))
        if doorstop_cfg is not None:
            text = _read_head(doorstop_cfg, 16 * 1024).decode("utf-8", "replace")
            m = re.search(r"^\s*target_assembly\s*=\s*(.+)$", text, re.M)
            if m:
                for x in loaders:
                    if x["name"] == "Doorstop":
                        x["details"]["targetAssembly"] = m.group(1).strip()
            if re.search(r"^\s*enabled\s*=\s*false", text, re.M | re.I):
                self.warnings.append("doorstop_config.ini: enabled = false — загрузчик выключен")
        if bep and bep.is_dir() and not any(x["name"] == "Doorstop" for x in loaders) and self.r["engine"] == "unity":
            self.warnings.append("папка BepInEx есть, но прокси doorstop не найден: загрузчик не стартует")

    # -- античит

    def _anticheat(self) -> None:
        seen = set()
        for p, is_dir in self.entries:
            name = p.name.lower()
            label = None
            if is_dir and name in ANTICHEAT_DIRS:
                label = ANTICHEAT_DIRS[name]
            elif not is_dir:
                for rx, lab in ANTICHEAT_FILES:
                    if rx.search(name):
                        label = lab
                        break
            if label and (label, rel(p, self.root)) not in seen:
                seen.add((label, rel(p, self.root)))
                self.r["antiCheat"].append({"name": label, "path": rel(p, self.root)})
        if self.r["antiCheat"]:
            names = sorted({x["name"] for x in self.r["antiCheat"]})
            self.warnings.insert(0, "АНТИЧИТ ({}): онлайн/античит — вне рамок, спросить пользователя".format(", ".join(names)))

    # -- Steam

    def _steam(self) -> None:
        txt = _ci_child(self.root, "steam_appid.txt")
        if txt:
            m = re.search(r"\d+", _read_head(txt, 64).decode("ascii", "replace"))
            if m:
                self.r["steamAppId"] = m.group(0)
        parts = self.root.parts
        low = [x.lower() for x in parts]
        for i in range(len(low) - 2, 0, -1):
            if low[i] == "common" and low[i - 1] == "steamapps" and i + 1 < len(parts):
                steamapps = Path(*parts[:i])
                installdir = parts[i + 1]
                for acf in steamapps.glob("appmanifest_*.acf"):
                    text = _read_head(acf, 64 * 1024).decode("utf-8", "replace")
                    m = re.search(r'"installdir"\s+"([^"]+)"', text)
                    if m and m.group(1).lower() == installdir.lower():
                        a = re.search(r'"appid"\s+"(\d+)"', text)
                        b = re.search(r'"buildid"\s+"(\d+)"', text)
                        if a:
                            self.r["steamAppId"] = a.group(1)
                        if b:
                            self.r["steamBuildId"] = b.group(1)
                        break
                break

    # -- хэши (для docs/07_builds.md)

    def _hashes(self) -> None:
        cands = []
        if self.r["exe"]:
            cands.append(self.root / self.r["exe"][0])
        for n in ("GameAssembly.dll",):
            p = _ci_child(self.root, n)
            if p:
                cands.append(p)
        if self.r["dataDir"] and self.r["engine"] == "unity":
            for n in ("Managed/Assembly-CSharp.dll", "il2cpp_data/Metadata/global-metadata.dat"):
                p = self.root / self.r["dataDir"] / n
                if p.is_file():
                    cands.append(p)
        for p in cands:
            h = sha256(p)
            if h:
                self.r["hashes"][rel(p, self.root)] = h

    # -- маршрут

    def _route(self) -> Dict:
        r = self.r
        steps: List[str] = []
        playbooks: List[str] = []
        lab = "Лаборатория: работать на копии игры, бэкап сейвов до первого запуска с модом (CORE-20), одноразовый слот"
        dumps = "Декомпиляцию и дампы держать вне папки проекта, не публиковать"
        bep = next((x for x in r["loaders"] if x["name"] == "BepInEx"), None)

        if r["antiCheat"]:
            return {"id": "stop-anticheat",
                    "summary": "СТОП: найден античит — онлайн/античит вне рамок набора, спросить пользователя",
                    "steps": ["Спросить пользователя: есть ли офлайн-режим/сборка без античита, "
                              "можно ли запускать игру без него (например, отдельная сборка от разработчика)",
                              "Ничего не устанавливать в папку игры до ответа"],
                    "playbooks": []}

        if r["engine"] == "unity":
            playbooks.append(PLAYBOOKS["detect"])
            uv = r["unityVersion"] or "?"
            unity6 = uv.startswith("6000")
            if r["backend"] == "il2cpp":
                playbooks.insert(0, PLAYBOOKS["il2cpp"])
                mv = r["metadataVersion"]
                summary = "IL2CPP{} -> BepInEx 6 BE (IL2CPP), закрепить номер сборки; Unity {}".format(
                    " v{}".format(mv) if mv is not None else "", uv)
                if bep and bep["version"]:
                    steps.append("BepInEx уже установлен ({}): убедиться, что это копия игры, закрепить эту сборку".format(bep["version"]))
                else:
                    steps.append("Поставить BepInEx 6 BE IL2CPP в копию игры, один запуск: сгенерируется BepInEx/interop (это reference для сборки и чтения)")
                if unity6:
                    steps.append("Unity 6: interop BE может падать (CoreCLR «Duplicate type») — быть готовым к InteropFix (пересохранение interop через Mono.Cecil)")
                if mv is None:
                    steps.append("metadata нестандартный: без стандартных дамперов, начать с BepInEx/interop или ручного разбора")
                else:
                    tool = "Cpp2IL 2022.1.0-pre-release.21"
                    if mv <= 29:
                        tool += " или Il2CppDumper (Perfare, до v29)"
                    elif mv >= 39:
                        tool += " (или форк Il2CppDumper с поддержкой v39)"
                    steps.append("Дамп типов офлайн: {} по global-metadata.dat v{} + GameAssembly.dll".format(tool, mv))
                bm = r["backupManaged"]
                if bm and bm["managedDlls"]:
                    steps.insert(0, "Есть {} ({} DLL, {} PDB): ilspycmd -p по Managed/Assembly-CSharp.dll — исходный C# с именами, читать в первую очередь".format(
                        bm["path"], bm["managedDlls"], bm["pdbs"]))
                rid = "unity-il2cpp-bepinex6"
            elif r["backend"] == "mono":
                playbooks.insert(0, PLAYBOOKS["mono"])
                summary = "Mono -> BepInEx 5 (5.4.x) + HarmonyX; Unity {}".format(uv)
                steps.append("ilspycmd -p по {}/Managed/Assembly-CSharp.dll (вне папки проекта), поиск rg".format(r["dataDir"]))
                if bep and bep["version"]:
                    steps.append("BepInEx уже установлен ({}): сверить ветку (5.x для Mono), не ставить вторую".format(bep["version"]))
                else:
                    steps.append("Распаковать BepInEx 5 x64 в копию игры, один запуск для конфигов, включить лог")
                rid = "unity-mono-bepinex5"
            else:
                summary = "Unity, бэкенд не определён — разобрать вручную по {}".format(PLAYBOOKS["detect"])
                rid = "unity-unknown"
            steps.append("Player.log: {}".format(r["playerLog"]["path"] if r["playerLog"] else "путь по app.info не найден"))
        elif r["engine"] == "unreal":
            playbooks.append(PLAYBOOKS["unreal"])
            summary = "Unreal {} -> UE4SS (Lua/C++), проверить совместимость UE4SS с версией движка".format(r["engineVersion"] or "?")
            if any(x["name"] == "UE4SS" for x in r["loaders"]):
                steps.append("UE4SS уже установлен: сверить версию, закрепить")
            else:
                steps.append("Поставить UE4SS в {} копии игры, включить консоль/дамп объектов".format(
                    str(Path(r["exe"][0]).parent) if r["exe"] else "Binaries/Win64"))
            steps.append("Дамп объектов/SDK средствами UE4SS, моды на Lua, ввод и связь — через файлы или сокет")
            rid = "unreal-ue4ss"
        elif r["engine"] == "godot":
            summary = "Godot {} — плейбука в наборе нет; согласовать маршрут с пользователем".format(r["engineVersion"] or "?")
            steps.append("Распаковка pck (gdsdecomp/GDRE Tools) вне папки проекта; моды — через подмену скриптов или загрузчик сообщества")
            rid = "godot-manual"
        else:
            summary = "Движок не определён{} — плейбука нет, спросить пользователя".format(
                " ({})".format(r["engineHint"]) if r["engineHint"] else "")
            steps.append("Проверить сообщества моддинга игры, найти существующий загрузчик")
            rid = "unknown"
        steps.append(lab)
        steps.append(dumps)
        return {"id": rid, "summary": summary, "steps": steps, "playbooks": playbooks}


def recon(game_dir, do_hash: bool = False, home: Optional[Path] = None) -> Dict:
    return Recon(Path(game_dir), do_hash=do_hash, home=home).run()


# ---------------------------------------------------------------- вывод

def _yn(v) -> str:
    return "есть" if v else "нет"


def stack_rows(r: Dict) -> List[Tuple[str, str]]:
    rows: List[Tuple[str, str]] = []
    eng = {"unity": "Unity", "unreal": "Unreal", "godot": "Godot", "other": "другой", "unknown": "не определён"}[r["engine"]]
    if r["engine"] == "unity":
        parts = [eng + " " + (r["unityVersion"] or "?")]
        if r["unityVersionSource"]:
            parts.append("(из {})".format(r["unityVersionSource"]))
        if r["backend"]:
            parts.append(", " + ("IL2CPP" if r["backend"] == "il2cpp" else "Mono"))
        if r["metadataVersion"] is not None:
            parts.append(", metadata v{}".format(r["metadataVersion"]))
        rows.append(("Движок", " ".join(parts).replace(" ,", ",")))
    else:
        rows.append(("Движок", " ".join(x for x in (eng, r["engineVersion"] or "", "({})".format(r["engineHint"]) if r["engineHint"] else "") if x)))
    rows.append(("Exe", ", ".join(r["exe"][:3]) + (" …" if len(r["exe"]) > 3 else "") if r["exe"] else "не найден"))
    if r["dataDir"]:
        dev = {True: " [development build]", False: " [release]", None: ""}[r["developmentBuild"]]
        rows.append(("Данные", r["dataDir"] + dev))
    if r["engine"] == "unity":
        bm = r["backupManaged"]
        rows.append(("BackUp", "{} (Managed: {} DLL, {} PDB{})".format(
            bm["path"], bm["managedDlls"], bm["pdbs"], ", GameAssembly.pdb" if bm["gameAssemblyPdb"] else "")
            if bm else "нет"))
        if r["appInfo"]:
            rows.append(("app.info", "{} / {}".format(r["appInfo"]["company"], r["appInfo"]["product"])))
    if r["playerLog"]:
        rows.append(("Лог игры", "{} ({})".format(r["playerLog"]["path"], _yn(r["playerLog"]["exists"]))))
    if r["engine"] == "unity":
        rows.append(("Библиотеки", ", ".join(x["name"] for x in r["libraries"]) or "известных не найдено"))
    ld = []
    for x in r["loaders"]:
        s = x["name"] + (" " + x["version"] if x["version"] else "")
        extra = []
        d = x["details"]
        if d.get("flavor"):
            extra.append(d["flavor"])
        if d.get("proxy"):
            extra.append(d["proxy"] + (", выключен" if d.get("disabled") else ""))
        if "plugins" in d:
            extra.append("плагинов {}".format(d["plugins"]))
        if d.get("interopDlls"):
            extra.append("interop {}".format(d["interopDlls"]))
        if extra:
            s += " (" + ", ".join(extra) + ")"
        ld.append(s)
    rows.append(("Загрузчики", "; ".join(ld) or "нет"))
    rows.append(("Античит", ", ".join("{} ({})".format(x["name"], x["path"]) for x in r["antiCheat"]) or "нет"))
    if r["steamAppId"] or r["steamBuildId"]:
        rows.append(("Steam", "appid {}{}".format(r["steamAppId"] or "?", ", build {}".format(r["steamBuildId"]) if r["steamBuildId"] else "")))
    else:
        rows.append(("Steam", "не найдено"))
    for k, v in r["hashes"].items():
        rows.append(("SHA-256", "{}: {}".format(k, v)))
    return rows


def format_human(r: Dict) -> str:
    out = ["Recon: " + r["gameDir"]]
    rows = stack_rows(r)
    w = max(len(k) for k, _ in rows) + 1
    for k, v in rows:
        out.append("{:<{w}} {}".format(k + ":", v, w=w + 1))
    rt = r["route"]
    out.append("{:<{w}} {}".format("Маршрут:", rt["summary"], w=w + 1))
    for i, s in enumerate(rt["steps"], 1):
        out.append("  {}. {}".format(i, s))
    if rt["playbooks"]:
        out.append("  Плейбуки: " + ", ".join(rt["playbooks"]))
    if r["warnings"]:
        out.append("Внимание:")
        out.extend("  ! " + x for x in r["warnings"])
    return "\n".join(out)


def _replace_block(text: str, name: str, body: str) -> str:
    begin, end = "<!-- recon:{}:begin -->".format(name), "<!-- recon:{}:end -->".format(name)
    i, j = text.find(begin), text.find(end)
    if i == -1 or j == -1 or j < i:
        return text
    return text[:i + len(begin)] + "\n" + body.rstrip() + "\n" + text[j:]


FALLBACK_PLAN = """# План моддинга: {{GAME}}

Создан: {{DATE}}. Папка игры (оригинал, только чтение): `{{GAME_DIR}}`.
Пометки: **[V]** проверено в игре, **[I]** выведено, **[W]** из веб-источников.
<!-- Шаблон набора game-helper не найден рядом со скриптом: использован встроенный минимальный. -->

## Цель

## Стек

<!-- recon:stack:begin -->
<!-- recon:stack:end -->

## Маршрут и почему

<!-- recon:route:begin -->
<!-- recon:route:end -->

Почему:

## Лаборатория

## Вертикальный срез

## Риски

## Проверка

## Открытые вопросы
"""


def find_plan_template() -> Optional[Path]:
    """Шаблон рядом со скриптом: набор (scripts/../templates/docs) или проект (tools/../docs, tools/)."""
    here = Path(__file__).resolve().parent
    for cand in (PLAN_TEMPLATE,
                 here / "templates" / "docs" / "MODDING_PLAN.md",
                 here / "MODDING_PLAN.template.md"):
        if cand.is_file():
            return cand
    return None


def render_plan(r: Dict, template: Optional[str] = None) -> str:
    if template is None:
        path = find_plan_template()
        template = path.read_text(encoding="utf-8") if path else FALLBACK_PLAN
    game = (r["appInfo"] or {}).get("product") or Path(r["gameDir"]).name
    stack = ["| Что | Значение |", "|---|---|", "| Папка игры | `{}` |".format(r["gameDir"])]
    for k, v in stack_rows(r):
        stack.append("| {} | {} |".format(k, v.replace("|", "\\|")))
    stack.append("")
    stack.append("Источник: `scripts/recon.py`, {}. Всё в таблице — [I], пока не подтверждено запуском.".format(
        _dt.date.today().isoformat()))
    if r["warnings"]:
        stack.append("")
        stack.extend("- ⚠ " + x for x in r["warnings"])
    rt = r["route"]
    route = ["Предложение recon (`{}`): **{}**".format(rt["id"], rt["summary"]), ""]
    route.extend("{}. {}".format(i, s) for i, s in enumerate(rt["steps"], 1))
    if rt["playbooks"]:
        route.append("")
        route.append("Плейбуки: " + ", ".join("`{}`".format(p) for p in rt["playbooks"]))
    text = template.replace("{{GAME}}", game).replace("{{GAME_DIR}}", r["gameDir"]).replace(
        "{{DATE}}", _dt.date.today().isoformat())
    text = _replace_block(text, "stack", "\n".join(stack))
    text = _replace_block(text, "route", "\n".join(route))
    return text


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Разведка установленной игры (только чтение).")
    ap.add_argument("game_dir", help="папка установки игры")
    ap.add_argument("--json", action="store_true", help="вывести JSON")
    ap.add_argument("--hash", action="store_true", help="SHA-256 основного exe, GameAssembly/Assembly-CSharp, metadata")
    ap.add_argument("--out", help="записать заполненный MODDING_PLAN.md по шаблону")
    ap.add_argument("--force", action="store_true", help="перезаписать существующий --out")
    args = ap.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass

    game = Path(args.game_dir)
    if not game.is_dir():
        print("Папка игры не найдена: {}".format(game), file=sys.stderr)
        return 1
    if args.out:
        out = Path(args.out)
        if _is_inside(out, game):
            print("Отказ: --out внутри папки игры ({}), recon в папку игры не пишет".format(out), file=sys.stderr)
            return 3
        if out.exists() and not args.force:
            print("Отказ: {} уже существует (добавьте --force, чтобы перезаписать)".format(out), file=sys.stderr)
            return 2

    r = recon(game, do_hash=args.hash)

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8", newline="\n") as fh:
            fh.write(render_plan(r))
    if args.json:
        enc = (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "")
        print(json.dumps(r, ensure_ascii=enc != "utf8", indent=2))
    else:
        print(format_human(r))
        if args.out:
            print("План записан: {}".format(args.out))
    if args.out and find_plan_template() is None:
        print("Шаблон templates/docs/MODDING_PLAN.md не найден рядом со скриптом — использован встроенный минимальный",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
