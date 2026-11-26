import {parseKeyboard, gamepadBinding, bindingConflict} from './bindings.mjs';

export function register(ctx, config) {
  const {state} = ctx;
  state.hotkeys ||= [
    {id:'freecam', label:'Свободная камера', keys:'Ctrl+P', default:'Ctrl+P'},
    {id:'hideUi', label:'Скрыть интерфейс игры', keys:'H', default:'H'},
    {id:'retake', label:'Дубль заново', keys:'F9', default:'F9'}
  ];
  const hasPad = config.modules.includes('gamepad');
  if (hasPad) for (const item of state.hotkeys) {
    item.gamepadDefault ??= item.id === 'freecam' ? 'View+Y' : '';
    item.gamepadKeys ??= item.gamepadDefault;
  }
  // Demo of a list section (contracts/adapter.md): the usual camera scheme from modules/freecam/GAMEPAD.md.
  // Every game fills its own section; sticks and triggers are fixed rows of the profile (config.hotkeySections).
  const section = 'Камера на контроллере';
  const camera = [['freecam.pad.faster','Быстрее','RB','Колесо вверх'],['freecam.pad.slower','Медленнее','LB','Колесо вниз'],
    ['freecam.pad.boost','Ускорение ×5, пока держишь','L3','Shift'],['freecam.pad.wider','Угол обзора шире','↑','Alt + колесо вверх'],['freecam.pad.narrower','Угол обзора уже','↓','Alt + колесо вниз']];
  if (hasPad) {
    for (const [id,label,keys] of camera) if (!state.hotkeys.some(item => item.id === id)) state.hotkeys.push({id,label,section,gamepadOnly:true,keys:'',gamepadKeys:keys,gamepadDefault:keys});
    config.hotkeySections ??= {[section]:{hint:'Работает, пока включена фрикамера. Стики и курки не переназначаются; столбец «Клавиатура» — для справки.',
      fixed:[{label:'Полёт вперёд / назад и в стороны',keys:'W A S D',gamepadKeys:'Левый стик'},{label:'Обзор',keys:'Мышь',gamepadKeys:'Правый стик'},{label:'Вверх / вниз',keys:'E / Q',gamepadKeys:'RT / LT'}],
      keyboard:Object.fromEntries(camera.map(([id,,,text]) => [id,text]))}};
  }
  state.settings ||= {gamePath:String.raw`C:\Games\Demo`, dataPath:String.raw`Документы\Demo Helper`};
  const gameKeys = {Tab:'Карта в игре', Esc:'Меню игры', F5:'Быстрое сохранение игры'};
  const get = id => {const item = state.hotkeys.find(i => i.id === id); if (!item) throw new Error('Нет такого хоткея.'); return item};
  ctx.on('hotkeys.set', ({id, keys}) => {
    keys = parseKeyboard(keys).keys;
    if (gameKeys[keys]) throw new Error('«' + keys + '» занята игрой: ' + gameKeys[keys] + '.');
    const conflict = bindingConflict(state.hotkeys,id,'keyboard',keys);
    if (conflict) throw new Error(conflict);
    get(id).keys = keys;
  });
  ctx.on('hotkeys.reset', ({id}) => {
    const item = get(id), keys = item.default || '';
    const conflict = bindingConflict(state.hotkeys,id,'keyboard',keys);
    if (conflict) throw new Error(conflict);
    item.keys = keys;
  });
  if (hasPad) {
    ctx.on('hotkeys.gamepad.set', ({id,keys}) => {
      keys = gamepadBinding(keys);
      const conflict = bindingConflict(state.hotkeys,id,'gamepad',keys);
      if (conflict) throw new Error(conflict);
      get(id).gamepadKeys = keys;
    });
    ctx.on('hotkeys.gamepad.reset', ({id}) => {
      const item = get(id), keys = item.gamepadDefault || '';
      const conflict = bindingConflict(state.hotkeys,id,'gamepad',keys);
      if (conflict) throw new Error(conflict);
      item.gamepadKeys = keys;
    });
  }
}
