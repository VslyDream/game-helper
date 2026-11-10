"""Copy the selected UI and requirements; never copy an unselected module."""
import argparse
import json
from pathlib import Path
import re
import shutil

KIT = Path(__file__).resolve().parents[1]
ENGINES = {'unity-il2cpp': 'plugin-il2cpp'}  # --engine → каркас плагина в templates/
ALLOWED = {'freecam', 'gamepad', 'snapshots', 'replay-camera', 'replay-players', 'distribution',
           'catalog', 'staging', 'mcp', 'controller'}


def create(profile, output):
    chosen = set(profile.get('modules', []))
    unknown = chosen - ALLOWED
    if unknown:
        raise ValueError('Неизвестные модули: ' + ', '.join(sorted(unknown)))
    if chosen & {'gamepad', 'replay-camera'} and 'freecam' not in chosen:
        raise ValueError('Геймпад и повтор камеры требуют явно выбрать freecam.')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', profile.get('id', '')):
        raise ValueError('id: латинские строчные буквы, цифры и дефисы; начать с буквы.')
    if output.exists():
        raise ValueError('Папка результата уже существует; выберите новую, чтобы сохранить её данные.')
    profile = dict(profile)
    profile['modules'] = sorted(chosen)
    profile['demo'] = bool(profile.get('demo', False))
    # Complete validation before the first write.
    source = KIT / 'assets' / 'site'
    ui_modules = ['cheats', 'settings']
    ui_modules += [m for m in ('freecam', 'snapshots', 'catalog', 'staging', 'controller') if m in chosen]
    if chosen & {'replay-camera', 'replay-players'}:
        ui_modules.append('replays')
    for module in ui_modules:
        if not (source / 'modules' / module / 'index.js').is_file():
            raise ValueError('Отсутствует ресурс: ' + module)
    if 'controller' in chosen and not (KIT / 'assets' / 'runtime' / 'controller_input.py').is_file():
        raise ValueError('Отсутствует Windows-провайдер контроллера.')
    engine = profile.get('engine') or None
    if engine is not None and engine not in ENGINES:
        raise ValueError('engine: ' + ', '.join(sorted(ENGINES)) + ' или пусто.')
    output.mkdir(parents=True)
    for item in ('index.html', 'style.css', 'app.js'):
        shutil.copy2(source / item, output / item)
    ignored = ([] if profile['demo'] else ['demo.js']) + ([] if any(m in ui_modules for m in ('snapshots','replays')) else ['gallery.css'])
    shutil.copytree(source / 'core', output / 'core', ignore=shutil.ignore_patterns(*ignored))
    for module in ui_modules:
        shutil.copytree(source / 'modules' / module, output / 'modules' / module,
                        ignore=shutil.ignore_patterns('demo.js') if not profile['demo'] else None)
    if 'catalog' in chosen:
        (output / 'catalog').mkdir()  # catalog/<name>.json is written once per project (CAT-01)
    (output / 'config.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    shutil.copy2(KIT / 'scripts' / 'serve.py', output / 'serve.py')
    if 'controller' in chosen:
        shutil.copy2(KIT / 'assets' / 'runtime' / 'controller_input.py', output / 'controller_input.py')
    requirements = output / 'requirements'
    requirements.mkdir()
    for name in ('core.md', 'ui.md', 'layout.md', 'process.md'):
        shutil.copy2(KIT / 'references' / name, requirements / name)
    shutil.copy2(KIT / 'contracts' / 'adapter.md', requirements / 'adapter.md')
    selected_specs = []
    for module in ('freecam', 'snapshots', 'distribution', 'catalog', 'staging', 'mcp', 'controller'):
        if module in chosen:
            target = module + '.md'
            shutil.copy2(KIT / 'modules' / module / 'SPEC.md', requirements / target)
            selected_specs.append(target)
            if (KIT / 'modules' / module / 'ADAPTER.md').exists():
                adapter_name = module + '-adapter.md'
                shutil.copy2(KIT / 'modules' / module / 'ADAPTER.md', requirements / adapter_name)
                selected_specs.append(adapter_name)
            if module == 'controller':
                shutil.copy2(KIT / 'modules' / module / 'VERIFIED.md', requirements / 'controller-verified.md')
                selected_specs.append('controller-verified.md')
    if 'gamepad' in chosen:
        shutil.copy2(KIT / 'modules/freecam/GAMEPAD.md', requirements / 'gamepad.md')
        selected_specs.append('gamepad.md')
    if 'replays' in ui_modules:
        shutil.copy2(KIT / 'modules/replays/SPEC.md', requirements / 'replays.md')
        shutil.copy2(KIT / 'modules/replays/ADAPTER.md', requirements / 'replays-adapter.md')
        selected_specs.extend(['replays.md','replays-adapter.md'])
    if 'replay-players' in chosen:
        shutil.copy2(KIT / 'contracts/world-state.md', requirements / 'world-state.md')
        selected_specs.append('world-state.md')
    # Этап исследования: заготовки docs/, правила и плейбуки, разведка и цикл сборки.
    templates = KIT / 'templates'
    shutil.copytree(templates / 'docs', output / 'docs',
                    ignore=shutil.ignore_patterns('MODDING_PLAN.md', 'knowledge-card.md'))
    shutil.copy2(templates / 'docs' / 'knowledge-card.md', output / 'docs' / 'knowledge.md')
    shutil.copytree(templates / 'tools', output / 'tools', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copy2(KIT / 'scripts' / 'recon.py', output / 'tools' / 'recon.py')
    # recon.py --out берёт шаблон плана рядом с собой.
    shutil.copy2(templates / 'docs' / 'MODDING_PLAN.md', output / 'tools' / 'MODDING_PLAN.template.md')
    for name in ('research.md', 'pitfalls.md', 'harmony-cheatsheet.md'):
        shutil.copy2(KIT / 'references' / name, requirements / name)
    shutil.copytree(KIT / 'references' / 'engines', requirements / 'engines')
    if engine:
        shutil.copytree(templates / ENGINES[engine], output / 'adapter',
                        ignore=shutil.ignore_patterns('bin', 'obj'))
    (output / 'AGENTS.md').write_text(
        '# Хелпер выбранной игры\n\nПрофиль: `config.json`. Начните с исследования: `requirements/research.md`, '
        'разведка `python tools/recon.py "<папка игры>" --out docs/MODDING_PLAN.md`, один плейбук движка из '
        '`requirements/engines/`, журнал `docs/MODLOG.md`, карточка игры `docs/knowledge.md`'
        + (', каркас плагина `adapter/`' if engine else '')
        + '.\n\nПеред сайтом и адаптером прочитайте `requirements/core.md`, `ui.md`, '
        '`layout.md`, `process.md` и `adapter.md` в той же папке. Дополнительные требования: '
        + (', '.join('`requirements/' + name + '`' for name in selected_specs) or 'нет')
        + '.\n\nРеализуйте игровой адаптер и выбранные читы. Ресурсы UI и демоданные не доказывают работу в игре. '
        'Демо явно включается профилем; отключите его перед проверкой реального подключения.\n', encoding='utf-8')
    (output / 'README.md').write_text(
        '# ' + profile.get('name', 'Игровой хелпер') + '\n\nСостав: '
        + (', '.join(sorted(chosen)) or 'только основа')
        + '.\n\nЛокальный просмотр: `python serve.py --port 18767`, затем http://127.0.0.1:18767/. '
        + ('Включён демонстрационный режим; он не управляет игрой.\n' if profile['demo'] else
           'Нужен настоящий API игры; сервер просмотра его не реализует.\n')
        + '\nДемо и реальный режим выбираются в `config.json`. Контракт — `requirements/adapter.md`. '
        'Пользовательские галереи и настройки хранятся отдельно от заменяемого сайта.\n', encoding='utf-8')
    if 'controller' in chosen:
        with (output / 'README.md').open('a', encoding='utf-8') as readme:
            readme.write('\nКонтроллер: «Настройки → Контроллер», `?page=settings#controller-check`. `serve.py` поднимает настоящий Windows/XInput API '
                         'независимо от деморежима игры. Для игрового адаптера импортируйте '
                         '`ControllerService` из `controller_input.py`, см. `requirements/controller-adapter.md`.\n')
    return ui_modules


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--modules', help='Точный набор через запятую; пустая строка — только основа')
    parser.add_argument('--name')
    parser.add_argument('--id')
    parser.add_argument('--demo', action='store_true', help='Локальные примеры вместо реальной игры')
    parser.add_argument('--engine', choices=sorted(ENGINES), help='Скопировать каркас плагина в adapter/')
    args = parser.parse_args()
    profile = json.loads((args.profile or KIT / 'project.example.json').read_text(encoding='utf-8-sig'))
    if args.modules is not None:
        profile['modules'] = [m.strip() for m in args.modules.split(',') if m.strip()]
    if args.name:
        profile['name'] = args.name
    if args.id:
        profile['id'] = args.id
    if args.engine:
        profile['engine'] = args.engine
    if args.demo:
        profile['demo'] = True
    try:
        copied = create(profile, args.output.resolve())
    except ValueError as error:
        parser.error(str(error))
    print('Готово:', args.output.resolve(), '| UI:', ', '.join(copied))


if __name__ == '__main__':
    main()
