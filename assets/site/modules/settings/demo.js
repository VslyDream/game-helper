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
  // Demo of a list section (contracts/adapter.md): the main camera layout from modules/freecam/GAMEPAD.md.
  // Sticks and triggers are fixed rows of the profile (config.hotkeySections). The rows of focus and aperture
  // (the last item of a row is true) need the optics of the free camera and are left out without it.
  const section = 'Камера на контроллере', optics = config.freecam?.optics !== false;
  const camera = [['freecam.pad.focusLock','Точка фокуса: закрепить / отпустить','A','Средняя кнопка мыши',true],
    ['freecam.pad.lookBoost','Ускорение поворота ×5, пока держишь','R3','—'],['freecam.pad.boost','Ускорение полёта ×5, пока держишь','L3','Shift'],
    ['freecam.pad.zoom','Зум: держать и жать RT / LT','LB','Alt + колесо'],['freecam.pad.focus','Фокус: держать и жать RT / LT','RB','Ctrl + колесо',true],
    ['freecam.pad.faster','Скорость быстрее','↑','Колесо вверх'],['freecam.pad.slower','Скорость медленнее','↓','Колесо вниз'],
    ['freecam.pad.wider','Диафрагма шире (больше размытия)','→','Ctrl + Alt + колесо вверх',true],['freecam.pad.narrower','Диафрагма уже','←','Ctrl + Alt + колесо вниз',true]]
    .filter(row => optics || !row[4]);
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
