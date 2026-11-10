"""Тесты scripts/recon.py на поддельных папках игр.

Запуск из корня набора: python -m unittest tests.test_recon -v
"""
import contextlib
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("recon", ROOT / "scripts" / "recon.py")
recon = importlib.util.module_from_spec(_spec)
sys.modules["recon"] = recon
_spec.loader.exec_module(recon)

STABLE_KEYS = {"engine", "backend", "unityVersion", "metadataVersion", "exe", "dataDir", "backupManaged",
               "appInfo", "playerLog", "libraries", "loaders", "antiCheat", "steamAppId", "route", "warnings"}


def version_resource(value, key="ProductVersion"):
    """Минимальный кусок VS_VERSION_INFO: ключ UTF-16, выравнивание, значение UTF-16."""
    return (b"\x00" * 64 + b"\x5c\x00\x1c\x00\x01\x00" + (key + "\0").encode("utf-16-le")
            + b"\x00\x00" + (value + "\0").encode("utf-16-le") + b"\x00" * 64)


def put(root, rel, data=b""):
    p = Path(root) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
    return p


def metadata(version, strings=b""):
    return struct.pack("<Ii", 0xFAB11BAF, version) + b"\x00" * 248 + strings


def snapshot(root):
    return sorted((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in Path(root).rglob("*"))


def make_mono(root):
    put(root, "Game.exe", b"MZ" + b"\x00" * 1000)
    put(root, "UnityCrashHandler64.exe", b"MZ")
    put(root, "UnityPlayer.dll", b"MZ" + version_resource("2021.3.5f1 (abcdef)"))
    put(root, "MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll", b"MZ")
    put(root, "Game_Data/globalgamemanagers", b"\x00" * 20 + b"2021.3.5f1\x00" + b"\x00" * 100)
    put(root, "Game_Data/app.info", "Acme Studio\nMy Game")
    for n in ("Assembly-CSharp", "Cinemachine", "Unity.InputSystem", "Unity.RenderPipelines.Universal.Runtime", "Rewired_Core"):
        put(root, "Game_Data/Managed/{}.dll".format(n), b"MZ")


def make_il2cpp(root, version, unity=None, product_version=None, backup=False):
    put(root, "Game.exe", b"MZ" + b"\x00" * 1000)
    put(root, "GameAssembly.dll", b"MZ" + b"\x00" * 100)
    put(root, "UnityPlayer.dll", b"MZ" + version_resource(product_version or "2022.3.62f3 (96770f904ca7)"))
    put(root, "Game_Data/il2cpp_data/Metadata/global-metadata.dat",
        metadata(version, b"\x00Assembly-CSharp.dll\x00Unity.InputSystem.dll\x00Mirror.dll\x00ES3Settings\x00"))
    put(root, "Game_Data/app.info", "Acme\nIl2cpp Game")
    if unity:
        put(root, "Game_Data/globalgamemanagers", b"\x00" * 48 + unity.encode() + b"\x00" * 64)
    if backup:
        b = "Game_BackUpThisFolder_ButDontShipItWithYourGame/Managed/"
        for n in ("Assembly-CSharp", "Unity.Cinemachine", "VContainer"):
            put(root, b + n + ".dll", b"MZ")
            put(root, b + n + ".pdb", b"PDB")
        put(root, "Game_BackUpThisFolder_ButDontShipItWithYourGame/GameAssembly.pdb", b"PDB")


class ReconTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.game = self.tmp / "Game"
        self.game.mkdir()
        self.home = self.tmp / "home"

    def tearDown(self):
        self._tmp.cleanup()

    def run_recon(self):
        return recon.recon(self.game, home=self.home)

    def run_main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = recon.main([str(self.game)] + list(args))
        return code, out.getvalue(), err.getvalue()

    def test_unity_mono(self):
        make_mono(self.game)
        r = self.run_recon()
        self.assertEqual(r["engine"], "unity")
        self.assertEqual(r["backend"], "mono")
        self.assertEqual(r["unityVersion"], "2021.3.5f1")
        self.assertEqual(r["unityVersionSource"], os.path.join("Game_Data", "globalgamemanagers"))
        self.assertEqual(r["exe"][0], "Game.exe")
        self.assertEqual(r["dataDir"], "Game_Data")
        self.assertIsNone(r["metadataVersion"])
        self.assertEqual(r["appInfo"], {"company": "Acme Studio", "product": "My Game"})
        self.assertTrue(r["playerLog"]["path"].endswith(os.path.join("LocalLow", "Acme Studio", "My Game", "Player.log")))
        self.assertFalse(r["playerLog"]["exists"])
        libs = {x["id"] for x in r["libraries"]}
        self.assertTrue({"cinemachine", "inputsystem", "urp", "rewired"} <= libs, libs)
        self.assertEqual(r["route"]["id"], "unity-mono-bepinex5")
        self.assertIn("references/engines/unity-mono-bepinex5.md", r["route"]["playbooks"])

    def test_player_log_exists(self):
        make_mono(self.game)
        put(self.home, "AppData/LocalLow/Acme Studio/My Game/Player.log", "Initialize engine version: 2021.3.5f1")
        self.assertTrue(self.run_recon()["playerLog"]["exists"])

    def test_il2cpp_v31_version_from_unityplayer(self):
        make_il2cpp(self.game, 31)
        r = self.run_recon()
        self.assertEqual(r["engine"], "unity")
        self.assertEqual(r["backend"], "il2cpp")
        self.assertEqual(r["metadataVersion"], 31)
        self.assertEqual(r["unityVersion"], "2022.3.62f3")
        self.assertIn("ProductVersion", r["unityVersionSource"])
        libs = {x["id"] for x in r["libraries"]}
        self.assertTrue({"inputsystem", "mirror", "es3"} <= libs, libs)
        self.assertIsNone(r["backupManaged"])
        self.assertEqual(r["route"]["id"], "unity-il2cpp-bepinex6")
        self.assertIn("v31", r["route"]["summary"])
        self.assertTrue(any("Cpp2IL" in s for s in r["route"]["steps"]))
        self.assertFalse(any("InteropFix" in s for s in r["route"]["steps"]))

    def test_il2cpp_v39_backup(self):
        make_il2cpp(self.game, 39, unity="6000.4.8f1", backup=True)
        r = self.run_recon()
        self.assertEqual(r["metadataVersion"], 39)
        self.assertEqual(r["unityVersion"], "6000.4.8f1")
        bm = r["backupManaged"]
        self.assertEqual(bm["managedDlls"], 3)
        self.assertEqual(bm["pdbs"], 3)
        self.assertTrue(bm["hasAssemblyCSharp"])
        self.assertTrue(bm["gameAssemblyPdb"])
        libs = {x["id"] for x in r["libraries"]}
        self.assertTrue({"cinemachine", "vcontainer", "mirror"} <= libs, libs)
        steps = " ".join(r["route"]["steps"])
        self.assertIn("InteropFix", steps)
        self.assertIn("ilspycmd", steps)
        self.assertIn("ilspycmd", r["route"]["steps"][0])

    def test_bad_metadata_magic(self):
        make_il2cpp(self.game, 31)
        put(self.game, "Game_Data/il2cpp_data/Metadata/global-metadata.dat", b"\x01\x02\x03\x04" + b"\x00" * 100)
        r = self.run_recon()
        self.assertIsNone(r["metadataVersion"])
        self.assertTrue(any("0xFAB11BAF" in w for w in r["warnings"]))

    def test_unreal(self):
        put(self.game, "Game.exe", b"MZ")
        put(self.game, "Engine/Binaries/ThirdParty/x.txt", "x")
        put(self.game, "Game/Binaries/Win64/Game-Win64-Shipping.exe",
            b"MZ" + b"\x00" * 300 + "++UE5+Release-5.3-CL-0".encode("utf-16-le") + b"\x00" * 300)
        put(self.game, "Game/Content/Paks/Game-Windows.pak", b"pak")
        r = self.run_recon()
        self.assertEqual(r["engine"], "unreal")
        self.assertEqual(r["engineVersion"], "5.3")
        self.assertEqual(r["exe"][0], os.path.join("Game", "Binaries", "Win64", "Game-Win64-Shipping.exe"))
        self.assertIn("pak: 1", r["engineHint"])
        self.assertEqual(r["route"]["id"], "unreal-ue4ss")
        self.assertIsNone(r["backend"])

    def test_unreal_ue4ss_installed(self):
        self.test_unreal_files()
        put(self.game, "Game/Binaries/Win64/ue4ss/UE4SS.dll", b"MZ" + version_resource("3.0.1"))
        put(self.game, "Game/Binaries/Win64/dwmapi.dll", b"MZ")
        r = self.run_recon()
        names = {x["name"]: x for x in r["loaders"]}
        self.assertEqual(names["UE4SS"]["version"], "3.0.1")
        self.assertIn("UE4SS proxy", names)

    def test_unreal_files(self):
        put(self.game, "Game.exe", b"MZ")
        put(self.game, "Game/Binaries/Win64/Game-Win64-Shipping.exe", b"MZ" + b"++UE4+Release-4.27" + b"\x00")
        put(self.game, "Game/Content/Paks/Game-WindowsNoEditor.pak", b"pak")
        self.assertEqual(self.run_recon()["engineVersion"], "4.27")

    def test_bepinex_il2cpp(self):
        make_il2cpp(self.game, 31)
        put(self.game, "BepInEx/core/BepInEx.Core.dll", b"MZ" + version_resource("6.0.0-be.788+5b766a3"))
        put(self.game, "BepInEx/core/BepInEx.Unity.IL2CPP.dll", b"MZ")
        put(self.game, "BepInEx/plugins/MyMod/MyMod.dll", b"MZ")
        put(self.game, "BepInEx/interop/Assembly-CSharp.dll", b"MZ")
        put(self.game, "winhttp.dll", b"MZ")
        put(self.game, "doorstop_config.ini", "[General]\nenabled = true\ntarget_assembly = BepInEx\\core\\BepInEx.Unity.IL2CPP.dll\n")
        put(self.game, ".doorstop_version", "4.5.0")
        r = self.run_recon()
        loaders = {x["name"]: x for x in r["loaders"]}
        bep = loaders["BepInEx"]
        self.assertEqual(bep["version"], "6.0.0-be.788+5b766a3")
        self.assertEqual(bep["details"]["flavor"], "IL2CPP")
        self.assertEqual(bep["details"]["plugins"], 1)
        self.assertEqual(bep["details"]["interopDlls"], 1)
        door = loaders["Doorstop"]
        self.assertEqual(door["version"], "4.5.0")
        self.assertEqual(door["details"]["proxy"], "winhttp.dll")
        self.assertIn("BepInEx.Unity.IL2CPP.dll", door["details"]["targetAssembly"])
        self.assertTrue(any("6.0.0-be.788" in s for s in r["route"]["steps"]))
        self.assertFalse(any("doorstop" in w.lower() for w in r["warnings"]), r["warnings"])

    def test_bepinex_disabled_and_mismatch(self):
        make_mono(self.game)
        put(self.game, "BepInEx/core/BepInEx.Core.dll", b"MZ" + version_resource("6.0.0-be.791"))
        put(self.game, "BepInEx/core/BepInEx.Unity.IL2CPP.dll", b"MZ")
        put(self.game, "winhttp.dll.disabled", b"MZ")
        put(self.game, "doorstop_config.ini", "enabled = true\n")
        r = self.run_recon()
        w = " ".join(r["warnings"])
        self.assertIn(".disabled", w)
        self.assertIn("IL2CPP-сборка стоит на Mono-игре", w)
        door = next(x for x in r["loaders"] if x["name"] == "Doorstop")
        self.assertTrue(door["details"]["disabled"])

    def test_anticheat(self):
        make_il2cpp(self.game, 31)
        put(self.game, "EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe", b"MZ")
        put(self.game, "start_protected_game.exe", b"MZ" + b"\x00" * 5000)
        r = self.run_recon()
        self.assertTrue(r["antiCheat"])
        self.assertEqual({x["name"] for x in r["antiCheat"]}, {"EasyAntiCheat"})
        self.assertIn("античит", r["warnings"][0])
        self.assertIn("спросить пользователя", r["warnings"][0])
        self.assertEqual(r["route"]["id"], "stop-anticheat")
        self.assertEqual(r["exe"][0], "Game.exe")  # лаунчер античита не основной exe

    def test_godot(self):
        put(self.game, "Game.exe", b"MZ")
        put(self.game, "Game.pck", b"GDPC" + struct.pack("<4I", 2, 4, 2, 1) + b"\x00" * 64)
        r = self.run_recon()
        self.assertEqual(r["engine"], "godot")
        self.assertEqual(r["engineVersion"], "4.2.1")

    def test_unknown(self):
        put(self.game, "Game.exe", b"MZ")
        r = self.run_recon()
        self.assertEqual(r["engine"], "unknown")
        self.assertEqual(r["route"]["id"], "unknown")

    def test_steam_appmanifest(self):
        steamapps = self.tmp / "lib" / "steamapps"
        self.game = steamapps / "common" / "Cool Game"
        make_mono(self.game)
        put(steamapps, "appmanifest_4461460.acf",
            '"AppState"\n{\n\t"appid"\t\t"4461460"\n\t"installdir"\t\t"Cool Game"\n\t"buildid"\t\t"26463558"\n}\n')
        put(steamapps, "appmanifest_1.acf", '"AppState"\n{\n\t"appid"\t\t"1"\n\t"installdir"\t\t"Other"\n}\n')
        r = self.run_recon()
        self.assertEqual(r["steamAppId"], "4461460")
        self.assertEqual(r["steamBuildId"], "26463558")

    def test_steam_appid_txt(self):
        make_mono(self.game)
        put(self.game, "steam_appid.txt", "480\n")
        self.assertEqual(self.run_recon()["steamAppId"], "480")

    def test_read_only_and_hash(self):
        make_il2cpp(self.game, 39, unity="6000.0.23f1", backup=True)
        before = snapshot(self.game)
        r = recon.recon(self.game, do_hash=True, home=self.home)
        self.assertEqual(snapshot(self.game), before)
        self.assertIn("Game.exe", r["hashes"])
        self.assertIn("GameAssembly.dll", r["hashes"])
        self.assertEqual(len(r["hashes"]["Game.exe"]), 64)

    def test_json_output_keys(self):
        make_mono(self.game)
        code, out, _ = self.run_main("--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertTrue(STABLE_KEYS <= set(data), STABLE_KEYS - set(data))
        self.assertIsInstance(data["libraries"], list)
        self.assertIsInstance(data["warnings"], list)

    def test_human_output(self):
        make_il2cpp(self.game, 31)
        code, out, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("Движок:", out)
        self.assertIn("IL2CPP", out)
        self.assertIn("metadata v31", out)
        self.assertIn("Маршрут:", out)

    def test_out_plan_and_refuse_overwrite(self):
        make_il2cpp(self.game, 31)
        plan = self.tmp / "project" / "docs" / "MODDING_PLAN.md"
        code, _, _ = self.run_main("--out", str(plan))
        self.assertEqual(code, 0)
        text = plan.read_text(encoding="utf-8")
        self.assertIn("Il2cpp Game", text)
        self.assertIn("metadata v31", text)
        self.assertIn("unity-il2cpp-bepinex6", text)
        self.assertIn("## Лаборатория", text)
        self.assertNotIn("{{GAME}}", text)
        plan.write_text("свой текст", encoding="utf-8")
        code, _, err = self.run_main("--out", str(plan))
        self.assertEqual(code, 2)
        self.assertIn("--force", err)
        self.assertEqual(plan.read_text(encoding="utf-8"), "свой текст")
        code, _, _ = self.run_main("--out", str(plan), "--force")
        self.assertEqual(code, 0)
        self.assertIn("metadata v31", plan.read_text(encoding="utf-8"))

    def test_out_inside_game_refused(self):
        make_mono(self.game)
        code, _, err = self.run_main("--out", str(self.game / "MODDING_PLAN.md"))
        self.assertEqual(code, 3)
        self.assertFalse((self.game / "MODDING_PLAN.md").exists())

    def test_plan_fallback_template(self):
        make_mono(self.game)
        r = self.run_recon()
        text = recon.render_plan(r, template=recon.FALLBACK_PLAN)
        self.assertIn("My Game", text)
        self.assertIn("unity-mono-bepinex5", text)
        self.assertIn("## Стек", text)

    def test_missing_dir(self):
        code, _, err = recon.main([str(self.tmp / "nope")]), None, None
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
