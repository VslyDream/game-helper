export async function createDemoBridge(config) {
  const storageKey = 'game-helper:' + config.id + ':demo';
  let state;
  try {state = JSON.parse(localStorage.getItem(storageKey))} catch {}
  state ||= {};
  state = {...state, connection:'level', gameRunning:true, operation:null, availability:{'game.launch':{enabled:false,reason:'Демосцена уже открыта'},'game.close':{enabled:true}}, role:'solo'};
  const handlers = new Map(), listeners = new Set(), disposers = [];
  let pending = false;
  const emit = () => {try {localStorage.setItem(storageKey, JSON.stringify(state))} catch {} for (const fn of listeners) fn(state)};
  const context = {
    state,
    on(command, handler) {handlers.set(command, handler); state.availability[command] = {enabled:true}},
    emit,
    onClose(fn) {disposers.push(fn)},
    id:() => crypto.randomUUID(),
    now:() => new Date().toISOString(),
    image(index = 0) {
      const colors = ['#648c8b','#8c739b','#7e865d'];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="${colors[index%3]}"/><path d="M0 330L300 235H800V450H0Z" fill="#c3b092"/><path d="M0 0H300V235L0 330Z" fill="#16343d" opacity=".45"/><rect x="380" y="65" width="270" height="160" rx="4" fill="#c3d0c4" opacity=".6"/><path d="M515 65V225M380 145H650" stroke="#507879" stroke-width="6"/><ellipse cx="485" cy="350" rx="90" ry="24" fill="#162b30" opacity=".3"/><rect x="430" y="240" width="110" height="100" rx="8" fill="#74596e"/><text x="24" y="425" font-family="Segoe UI,Arial" font-size="20" fill="#fff">Демокадр</text></svg>`;
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }
  };
  context.on('game.launch', () => {state.gameRunning = true; state.connection = 'level'});
  context.on('game.close', () => {state.gameRunning = false; state.connection = 'closed'});
  state.availability['game.launch'].enabled = !state.gameRunning;
  state.availability['game.close'].enabled = state.gameRunning;
  const active = ['cheats', 'settings'];
  if (config.modules.includes('freecam')) active.push('freecam');
  if (config.modules.includes('snapshots')) active.push('snapshots');
  if (config.modules.includes('catalog')) active.push('catalog');
  if (config.modules.includes('staging')) active.push('staging');
  if (config.modules.some(m => m.startsWith('replay-'))) active.push('replays');
  const demos = await Promise.all(active.map(module => import('../modules/' + module + '/demo.js')));
  for (const demo of demos) demo.register(context, config);
  const bridge = {
    get state() {return state}, get busy() {return pending},
    subscribe(fn) {listeners.add(fn); fn(state); return () => listeners.delete(fn)},
    available(command) {const item = state.availability[command]; return {enabled:!!item?.enabled && !pending,reason:pending?'Выполняется операция':item?.reason || 'Недоступно в этой демонстрации'}},
    async call(command, args = {}) {
      if (pending) throw new Error('Дождитесь завершения операции.');
      const handler = handlers.get(command);
      if (!handler) throw new Error('В демонстрации нет этой команды.');
      pending = true; emit();
      try {
        const result = await handler(args);
        state.availability['game.launch'].enabled = !state.gameRunning;
        state.availability['game.close'].enabled = state.gameRunning;
        return {ok:true, state, ...result};
      } finally {pending = false; emit()}
    },
    async refresh() {emit()},
    close() {for (const fn of disposers) fn(); listeners.clear()}
  };
  return bridge;
}
