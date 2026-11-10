"""The module manifest is the single source: files exist, docs mention every flag."""
import json
from pathlib import Path
import unittest

KIT = Path(__file__).resolve().parents[1]
MODULES = json.loads((KIT / 'modules/manifest.json').read_text(encoding='utf-8'))


class ManifestTests(unittest.TestCase):
    def test_files_and_dependencies_exist(self):
        for name, module in MODULES.items():
            for path in list(module.get('specs', {}).values()) + list(module.get('runtime', {}).values()):
                self.assertTrue((KIT / path).is_file(), f'{name}: {path}')
            if module.get('ui'):
                self.assertTrue((KIT / 'assets/site/modules' / module['ui'] / 'index.js').is_file(), name)
            for dependency in module.get('requires', []):
                self.assertIn(dependency, MODULES, name)

    def test_route_and_request_mention_every_module(self):
        skill = (KIT / 'SKILL.md').read_text(encoding='utf-8')
        for name, module in MODULES.items():
            self.assertIn('`' + name + '`', skill, name)
            for path in module.get('specs', {}).values():
                self.assertIn(Path(path).parent.as_posix(), skill, path)

    def test_site_loads_only_known_modules(self):
        app = (KIT / 'assets/site/app.js').read_text(encoding='utf-8')
        for name, module in MODULES.items():
            if module.get('ui'):
                self.assertIn("selected.has('" + name + "')", app, name)


if __name__ == '__main__':
    unittest.main()
