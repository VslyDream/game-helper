import {h, notify, commandButton} from './core/ui.js';
import {createBridge} from './core/bridge.js';
import {mountNavigation} from './core/navigation.js';

async function start() {
  const configResponse = await fetch('./config.json');
  if (!configResponse.ok) throw new Error('Не удалось открыть профиль хелпера.');
  const config = await configResponse.json();
  const selected = new Set(config.modules);
  // Start every module download at once; mounting below stays in a fixed order.
  const load = (flag, path) => flag ? import(path) : null;
  const modules = {
    cheats:load(true, './modules/cheats/index.js'),
    settings:load(true, './modules/settings/index.js'),
    freecam:load(selected.has('freecam'), './modules/freecam/index.js'),
    snapshots:load(selected.has('snapshots'), './modules/snapshots/index.js'),
    replays:load(selected.has('replay-camera') || selected.has('replay-players'), './modules/replays/index.js'),
    catalog:load(selected.has('catalog'), './modules/catalog/index.js'),
    staging:load(selected.has('staging'), './modules/staging/index.js'),
    controller:load(selected.has('controller'), './modules/controller/index.js')
  };
  for (const promise of Object.values(modules)) promise?.catch(() => {});
  const bridge = await createBridge(config);
  const context = {config, bridge};
  if (selected.has('snapshots') || selected.has('replay-camera') || selected.has('replay-players'))
    document.head.append(h('link', {rel:'stylesheet',href:'./core/gallery.css'}));
  const requestedPage = new URLSearchParams(location.search).get('page') || 'cheats';
  const page = requestedPage === 'controller' && selected.has('controller') ? 'settings' : requestedPage;
  if (requestedPage === 'controller' && selected.has('controller')) history.replaceState(null, '', '?page=settings#controller-check');
  const pages = [{id:'cheats', title:'🎮 Читы'}];
  if (selected.has('snapshots')) pages.push({id:'saves', title:'💾 Сохранения'});
  if (selected.has('replay-camera') || selected.has('replay-players')) pages.push({id:'replays', title:'🎬 Записи и повторы'});
  // Project pages: config.json → pages [{id,title,module}]; the shell itself stays unchanged.
  const reserved = new Set(pages.map(p => p.id).concat('settings'));
  for (const extra of config.pages || []) {
    if (/^[a-z][a-z0-9-]*$/.test(extra.id || '') && !reserved.has(extra.id) && extra.module) {pages.push({...extra, custom:true}); reserved.add(extra.id)}
  }
  pages.push({id:'settings', title:'⚙ Настройки'});
  const active = pages.some(p => p.id === page) ? page : 'cheats';
  if (page !== active) history.replaceState(null, '', '?page=cheats');
  const nameNode = document.getElementById('app-name');
  nameNode.firstChild.textContent = config.name;
  document.getElementById('game-name').textContent = config.game || '';
  document.title = pages.find(p => p.id === active).title.replace(/^\S+\s/, '') + ' · ' + config.name;
  document.getElementById('footer').textContent = config.demo ? 'Деморежим · к игре не подключён' : (config.version || '');
  mountNavigation(pages, active);
  const content = document.getElementById('content');
  const sections = {};
  for (const item of pages) {
    sections[item.id] = h('section', {hidden:item.id !== active, 'data-page':item.id});
    content.append(sections[item.id]);
  }
  if (selected.has('catalog')) {
    document.head.append(h('link', {rel:'stylesheet',href:'./modules/catalog/style.css'}));
    context.pick = (await modules.catalog).pickControl;
  }
  const cheats = await modules.cheats;
  const cheatLayout = cheats.mount(sections.cheats, context);
  if (selected.has('freecam')) {
    const camera = await modules.freecam;
    camera.mount(cheatLayout, context);
  }
  if (selected.has('staging')) (await modules.staging).mount(cheatLayout, context);
  if (selected.has('snapshots')) (await modules.snapshots).mount(sections.saves, context);
  if (sections.replays) (await modules.replays).mount(sections.replays, context);
  const custom = pages.filter(p => p.custom).map(item => [item, import(new URL(item.module, location.href).href)]);
  for (const [item, promise] of custom) {
    try {(await promise).mount(sections[item.id], context)}
    catch (error) {sections[item.id].append(h('p', {class:'hint'}, 'Страница не загрузилась: ' + error.message))}
  }
  const settingsInstance = (await modules.settings).mount(sections.settings, context);
  let controllerSettings = null;
  if (selected.has('controller')) {
    document.head.append(h('link', {rel:'stylesheet',href:'./modules/controller/style.css'}));
    const controller = await modules.controller;
    controllerSettings = controller.mountSettings(sections.settings, context);
  }
  const categories = document.getElementById('categories');
  categories.hidden = active !== 'cheats';
  for (const section of cheatLayout.querySelectorAll('section[id]')) {
    categories.append(h('a', {href:'?page=cheats#' + section.id}, section.querySelector('h2').textContent));
  }
  document.getElementById('game-controls').append(
    commandButton('Запустить игру', 'game.launch', context, () => ({}), 'quiet'),
    commandButton('Закрыть игру', 'game.close', context, () => ({}), 'quiet')
  );
  bridge.subscribe(state => {
    const labels = {offline:'Сервис недоступен', closed:'Игра закрыта', starting:'Игра запускается', waiting:'Ожидание подключения', menu:'Подключено меню', level:'Игра подключена', error:'Ошибка подключения'};
    const role = {host:'хост', client:'клиент'}[state.role];
    document.getElementById('connection-text').textContent = config.demo ? 'Режим макета' : (labels[state.connection] || 'Ожидание подключения') + (role ? ' · ' + role : '');
    document.getElementById('connection-dot').classList.toggle('connected', ['menu','level'].includes(state.connection));
    const operation = document.getElementById('operation');
    operation.hidden = !state.operation;
    operation.textContent = state.operation?.message || state.operation?.stage || '';
  });
  await bridge.refresh();
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  addEventListener('pagehide', () => {settingsInstance?.dispose(); controllerSettings?.dispose(); bridge.close()}, {once:true});
}
start().catch(error => notify(error.message));
