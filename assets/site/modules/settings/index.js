import {h, heading, notify} from '../../core/ui.js';
import {PAD_BUTTONS, parseKeyboard, keyboardBinding, gamepadBinding, comboFromEvent, bindingConflict} from './bindings.mjs';
export {comboFromEvent} from './bindings.mjs';

export function mount(parent, context) {
  const {bridge} = context;
  const table = h('div', {class:'hotkey-table',role:'table','aria-label':'Привязки действий'});
  const paths = h('div', {class:'control-grid'});
  parent.append(heading('Настройки'),
    h('section', {class:'panel',id:'settings-hotkeys'},h('h2',{},'⌨ Хоткеи'),table),
    h('section', {class:'panel',id:'settings-paths',style:'margin-top:14px'},h('h2',{},'📁 Пути'),paths));
  let signature = '', editor = null;

  function editBinding(item, device) {
    const isPad = device === 'gamepad', field = isPad ? 'gamepadKeys' : 'keys';
    const command = isPad ? 'hotkeys.gamepad.set' : 'hotkeys.set';
    const error = h('p', {class:'binding-error',role:'alert',hidden:true});
    const preview = h('output', {class:'binding-preview','aria-label':'Комбинация'});
    const save = h('button', {type:'submit',class:'primary'},'Сохранить');
    const cancel = h('button', {type:'button',class:'quiet'},'Отмена');
    const clear = h('button', {type:'button',class:'quiet'},'Снять привязку');
    const form = h('form', {},h('h2',{},(isPad ? '🎮 Геймпад' : '⌨ Клавиатура') + ' · ' + item.label));
    const dialog = h('dialog', {class:'binding-dialog','aria-label':(isPad ? 'Геймпад: ' : 'Клавиатура: ') + item.label},form);
    editor?.close(); editor = dialog;
    let read, firstInput, capturing = false;
    const showError = message => {error.textContent = message; error.hidden = !message;};
    const update = () => {
      showError('');
      try {const value = read(); preview.value = value ? value.replaceAll('+',' + ') : 'Не назначено'; save.disabled = false;}
      catch (failure) {preview.value = '—'; showError(failure.message); save.disabled = true;}
    };
    if (isPad) {
      let selected = [];
      try {selected = gamepadBinding(item[field]).split('+');} catch {}
      const inputs = new Map(), grid = h('div', {class:'pad-binding-grid'});
      for (const name of PAD_BUTTONS) {
        const input = h('input', {type:'checkbox',checked:selected.includes(name),'aria-label':'Кнопка ' + name});
        inputs.set(name,input); input.onchange = update;
        grid.append(h('label', {},input,h('span',{},name)));
      }
      firstInput = inputs.get('View');
      read = () => gamepadBinding([...inputs].filter(([,input]) => input.checked).map(([name]) => name));
      form.append(h('p',{class:'hint'},'Выберите одну кнопку или комбинацию. Привязка клавиатуры сохранится.'),grid);
    } else {
      let initial = {key:'',ctrl:false,alt:false,shift:false};
      try {initial = parseKeyboard(item[field]);} catch {}
      const key = h('input', {type:'text',value:initial.key,maxlength:32,autocomplete:'off',spellcheck:'false',placeholder:'P, F9, Num9…','aria-label':'Клавиша'});
      firstInput = key;
      const modifiers = Object.fromEntries(['ctrl','shift','alt'].map(name => [name,h('input',{type:'checkbox',checked:initial[name],'aria-label':name === 'ctrl' ? 'Ctrl' : name === 'shift' ? 'Shift' : 'Alt'})]));
      const capture = h('button', {type:'button',class:'quiet'},'Считать нажатие');
      capture.onclick = () => {capturing = !capturing; capture.textContent = capturing ? 'Нажмите комбинацию…' : 'Считать нажатие';};
      key.oninput = () => {capturing = false; capture.textContent = 'Считать нажатие'; update();};
      for (const input of Object.values(modifiers)) input.onchange = update;
      read = () => {
        const parsed = parseKeyboard(key.value);
        return keyboardBinding(parsed.key,{ctrl:modifiers.ctrl.checked || parsed.ctrl,shift:modifiers.shift.checked || parsed.shift,alt:modifiers.alt.checked || parsed.alt});
      };
      dialog.addEventListener('keydown', event => {
        if (!capturing) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') {capturing = false; capture.textContent = 'Считать нажатие'; return;}
        try {
          const keys = comboFromEvent(event);
          if (!keys) return;
          const parsed = parseKeyboard(keys); key.value = parsed.key;
          for (const name of Object.keys(modifiers)) modifiers[name].checked = parsed[name];
          capturing = false; capture.textContent = 'Считать нажатие'; update();
        } catch (failure) {showError(failure.message);}
      });
      form.append(h('div',{class:'binding-keyboard'},h('label',{class:'control'},h('span',{},'Клавиша'),key),
        h('div',{class:'modifier-row'},...Object.entries(modifiers).map(([name,input]) => h('label',{},input,name === 'ctrl' ? 'Ctrl' : name === 'shift' ? 'Shift' : 'Alt'))),capture),
        h('p',{class:'hint'},'Можно ввести комбинацию целиком, например Ctrl+Shift+P. Считывание нажатия необязательно.'));
    }
    const commit = async keys => {
      const availability = bridge.available(command);
      if (!availability.enabled) {showError(availability.reason); return;}
      const conflict = bindingConflict(bridge.state.hotkeys || [],item.id,device,keys);
      if (conflict) {showError(conflict); return;}
      save.disabled = clear.disabled = true;
      try {await bridge.call(command,{id:item.id,keys}); dialog.close();}
      catch (failure) {showError(failure.message); save.disabled = clear.disabled = false;}
    };
    form.onsubmit = event => {event.preventDefault(); try {commit(read());} catch (failure) {showError(failure.message);}};
    cancel.onclick = () => dialog.close(); clear.onclick = () => commit('');
    form.append(h('div',{class:'binding-result'},h('span',{},'Комбинация'),preview),error,h('div',{class:'inline wrap dialog-actions'},clear,cancel,save));
    dialog.onclose = () => {dialog.remove(); if (editor === dialog) editor = null;};
    document.body.append(dialog); update(); dialog.showModal(); firstInput?.focus();
  }

  function deviceCell(item, device) {
    const isPad = device === 'gamepad', label = isPad ? 'Геймпад' : 'Клавиатура';
    const field = isPad ? 'gamepadKeys' : 'keys', defaultField = isPad ? 'gamepadDefault' : 'default';
    const command = isPad ? 'hotkeys.gamepad.set' : 'hotkeys.set', resetCommand = isPad ? 'hotkeys.gamepad.reset' : 'hotkeys.reset';
    const available = bridge.available(command), resetAvailable = bridge.available(resetCommand);
    const assigned = !!item[field];
    const button = h('button',{type:'button',class:'hotkey-key' + (assigned ? '' : ' empty'),'aria-label':`Назначить ${isPad ? 'геймпад' : 'клавиатуру'}: ${item.label}`,disabled:!available.enabled,title:available.enabled ? '' : available.reason},assigned ? item[field].replaceAll('+',' + ') : '＋ Назначить');
    button.onclick = () => editBinding(item,device);
    // Reset exists only where there is something to reset: the binding differs from its default.
    const changed = item[defaultField] !== undefined && (item[field] || '') !== (item[defaultField] || '');
    const back = item[defaultField] ? item[defaultField].replaceAll('+',' + ') : 'без привязки';
    const reset = changed ? h('button',{type:'button',class:'quiet hotkey-reset','aria-label':`Вернуть ${back}: ${item.label}`,title:'Вернуть ' + back,disabled:!resetAvailable.enabled},'↺') : null;
    if (changed) button.classList.add('changed');
    if (reset) reset.onclick = async () => {try {await bridge.call(resetCommand,{id:item.id});} catch (failure) {notify(failure.message);}};
    let warning = isPad ? item.gamepadConflict : item.conflict;
    try {warning ||= bindingConflict(bridge.state.hotkeys || [],item.id,device,item[field] || '');} catch {}
    return h('div',{class:'hotkey-cell',role:'cell'},h('small',{class:'hotkey-device-label'},label),h('div',{class:'inline'},button,reset),warning ? h('small',{class:'hotkey-warning'},warning) : null);
  }
  function render() {
    const state = bridge.state;
    const next = JSON.stringify([state.hotkeys,state.settings,bridge.busy,state.availability]);
    if (next === signature) return; signature = next;
    const items = state.hotkeys || [];
    const hasPad = context.config.modules.includes('gamepad') || !!state.availability?.['hotkeys.gamepad.set']?.enabled || items.some(item => item.gamepadKeys);
    table.classList.toggle('keyboard-only',!hasPad);
    const header = h('div',{class:'hotkey-row hotkey-header',role:'row'},h('span',{role:'columnheader'},'Действие'),h('span',{role:'columnheader'},'Клавиатура'),hasPad ? h('span',{role:'columnheader'},'Геймпад') : null);
    table.replaceChildren(header,...items.map(item => h('div',{class:'hotkey-row',role:'row'},h('span',{role:'cell',class:'hotkey-action'},item.label),deviceCell(item,'keyboard'),hasPad ? deviceCell(item,'gamepad') : null)));
    if (!items.length) table.replaceChildren(h('p',{class:'hint'},'Хоткеев пока нет.'));
    const settings = state.settings || {};
    const field = (key,label) => h('label',{class:'control'},h('span',{},label),h('input',{type:'text',value:settings[key] || '',readonly:true,'aria-label':label}));
    paths.replaceChildren(field('gamePath','Папка игры'),field('dataPath','Данные хелпера'));
  }
  const unsubscribe = bridge.subscribe(render);
  return {dispose() {unsubscribe(); editor?.close();}};
}
