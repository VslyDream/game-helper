export function register(ctx) {
  const {state} = ctx;
  state.hotkeys ||= [
    {id:'freecam', label:'Свободная камера', keys:'Ctrl+P', default:'Ctrl+P'},
    {id:'hideUi', label:'Скрыть интерфейс игры', keys:'H', default:'H'},
    {id:'retake', label:'Дубль заново', keys:'F9', default:'F9'}
  ];
  state.settings ||= {gamePath:String.raw`C:\Games\Demo`, dataPath:String.raw`Документы\Demo Helper`};
  const gameKeys = {Tab:'Карта в игре', Esc:'Меню игры', F5:'Быстрое сохранение игры'};
  const get = id => {const item = state.hotkeys.find(i => i.id === id); if (!item) throw new Error('Нет такого хоткея.'); return item};
  ctx.on('hotkeys.set', ({id, keys}) => {
    if (gameKeys[keys]) throw new Error('«' + keys + '» занята игрой: ' + gameKeys[keys] + '.');
    get(id).keys = keys;
  });
  ctx.on('hotkeys.reset', ({id}) => {const item = get(id); item.keys = item.default});
}
