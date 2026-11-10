"""Acceptance: selected controller works alone; omitted modules stay absent."""
from http.client import HTTPConnection
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

KIT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


generator = load('kit_generator', KIT / 'scripts/create_project.py')
preview = load('kit_preview', KIT / 'scripts/serve.py')


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='game-helper-controller-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def generate(self, name, modules):
        output = self.root / name
        generator.create({'id':name, 'name':'Test helper', 'modules':modules, 'demo':True, 'cheats':[]}, output)
        return output

    def request(self, server, path):
        client = HTTPConnection('127.0.0.1', server.server_port, timeout=3)
        try:
            client.request('GET', path)
            response = client.getresponse()
            return response.status, response.read(), response.getheader('Content-Type')
        finally:
            client.close()

    def test_controller_is_independent_and_has_live_api(self):
        output = self.generate('controller-only', ['controller'])
        self.assertFalse((output / 'modules/freecam').exists())
        self.assertEqual(set(p.name for p in (output / 'modules').iterdir()), {'controller','cheats','settings'})
        self.assertTrue((output / 'requirements/controller-verified.md').exists())
        server = preview.make_server(output, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, data, _ = self.request(server, '/api/controller/state')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)['source'], 'windows')
            for path in ('/modules/controller/index.js', '/modules/controller/input.mjs', '/modules/controller/controller.svg'):
                status, _, content_type = self.request(server, path)
                self.assertEqual(status, 200, path)
                if path.endswith('.mjs'):
                    self.assertEqual(content_type, 'text/javascript')
        finally:
            server.shutdown()
            server.controller.stop()
            server.server_close()
            thread.join(timeout=3)

    def test_omitted_controller_has_no_assets_specs_provider_or_sampler(self):
        output = self.generate('minimal', [])
        self.assertFalse((output / 'modules/controller').exists())
        self.assertFalse((output / 'controller_input.py').exists())
        self.assertFalse(list((output / 'requirements').glob('controller*')))
        server = preview.make_server(output, 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertIsNone(server.controller)
            self.assertEqual(self.request(server, '/api/controller/state')[0], 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_existing_gamepad_dependency_and_exact_selection_preserved(self):
        with self.assertRaises(ValueError):
            self.generate('invalid-gamepad', ['gamepad'])
        self.assertFalse((self.root / 'invalid-gamepad').exists())
        output = self.generate('camera-pad', ['freecam','gamepad'])
        self.assertTrue((output / 'requirements/gamepad.md').exists())
        self.assertFalse((output / 'controller_input.py').exists())
        self.assertFalse((output / 'modules/controller').exists())
        full = self.generate('camera-controller', ['freecam','gamepad','controller'])
        self.assertTrue((full / 'modules/freecam/index.js').exists())
        self.assertTrue((full / 'controller_input.py').exists())


if __name__ == '__main__':
    unittest.main()
