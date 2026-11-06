import {h, notify, commandButton} from './core/ui.js';
import {createBridge} from './core/bridge.js';

async function start() {
  const configResponse = await fetch('./config.json');
  if (!configResponse.ok) throw new Error('Не удалось открыть профиль хелпера.');
  const config = await configResponse.json();
  const selected = new Set(config.modules);
  const bridge = await createBridge(config);
  const context = {config, bridge};
  if (selected.has('snapshots') || selected.has('replay-camera') || selected.has('replay-players'))
    document.head.append(h('link', {rel:'stylesheet',href:'./core/gallery.css'}));
  const page = new URLSearchParams(location.search).get('page') || 'cheats';
  const pages = [{id:'cheats', title:'🎮 Читы'}];
  if (selected.has('snapshots')) pages.push({id:'saves', title:'💾 Сохранения'});
  if (selected.has('replay-camera') || selected.has('replay-players')) pages.push({id:'replays', title:'🎬 Записи и повторы'});
  const active = pages.some(p => p.id === page) ? page : 'cheats';
  if (page !== active) history.replaceState(null, '', '?page=cheats');
  const nameNode = document.getElementById('app-name');
  nameNode.firstChild.textContent = config.name;
  document.getElementById('game-name').textContent = config.game || '';
  document.title = pages.find(p => p.id === active).title.slice(3) + ' · ' + config.name;
  document.getElementById('footer').textContent = config.demo ? 'Деморежим · к игре не подключён' : (config.version || '');
  for (const item of pages) {
    document.getElementById('pages').append(h('a', {
      href:'?page=' + item.id, class:item.id === active ? 'active' : '',
      'aria-current':item.id === active ? 'page' : null
    }, item.title));
  }
  const content = document.getElementById('content');
  const sections = {};
  for (const item of pages) {
    sections[item.id] = h('section', {hidden:item.id !== active, 'data-page':item.id});
    content.append(sections[item.id]);
  }
  const cheats = await import('./modules/cheats/index.js');
  const cheatLayout = cheats.mount(sections.cheats, context);
  if (selected.has('freecam')) {
    const camera = await import('./modules/freecam/index.js');
    camera.mount(cheatLayout, context);
  }
  if (selected.has('snapshots')) (await import('./modules/snapshots/index.js')).mount(sections.saves, context);
  if (sections.replays) (await import('./modules/replays/index.js')).mount(sections.replays, context);
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
  addEventListener('pagehide', () => bridge.close(), {once:true});
}
start().catch(error => notify(error.message));
