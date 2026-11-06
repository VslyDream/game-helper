import {h, heading, notify} from '../../core/ui.js';

// Rare things only: hotkeys with rebinding, game path, data folder (UI-15).
const MODIFIERS = new Set(['Control','Shift','Alt','Meta']);
export function comboFromEvent(event) {
  if (MODIFIERS.has(event.key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  let key = event.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num');
  if (key === 'Space') key = 'Пробел';
  parts.push(key);
  return parts.join('+');
}

export function mount(parent, context) {
  const {bridge} = context;
  const table = h('div', {class:'hotkey-table'});
  const paths = h('div', {class:'control-grid'});
  parent.append(heading('Настройки'),
    h('section', {class:'panel', id:'settings-hotkeys'}, h('h2', {}, '⌨ Хоткеи'), table),
    h('section', {class:'panel', id:'settings-paths', style:'margin-top:14px'}, h('h2', {}, '📁 Пути'), paths));
  let capturing = null, signature = '';

  async function send(command, args) {
    try {await bridge.call(command, args)} catch (error) {notify(error.message)}
  }
  function row(item, all) {
    const duplicate = all.find(other => other.id !== item.id && other.keys && other.keys === item.keys);
    const warning = item.conflict || (duplicate ? 'Совпадает с «' + duplicate.label + '»' : '');
    const keyButton = h('button', {type:'button', class:'hotkey-key', 'aria-label':'Назначить: ' + item.label},
      capturing === item.id ? 'Нажмите клавиши…' : (item.keys || '—'));
    keyButton.onclick = () => {capturing = item.id; render(true)};
    // The row is rebuilt on every render, so focus the fresh button while capturing.
    if (capturing === item.id) queueMicrotask(() => keyButton.focus());
    keyButton.onkeydown = event => {
      if (capturing !== item.id) return;
      event.preventDefault();
      if (event.key === 'Escape') {capturing = null; render(true); return}
      const keys = comboFromEvent(event);
      if (!keys) return;
      const taken = all.find(other => other.id !== item.id && other.keys === keys);
      if (taken) {notify('«' + keys + '» уже у «' + taken.label + '».'); return}
      capturing = null; send('hotkeys.set', {id:item.id, keys});
    };
    keyButton.onblur = () => {if (capturing === item.id && keyButton.isConnected) {capturing = null; render(true)}};
    const reset = h('button', {type:'button', class:'quiet', disabled:!item.default || item.keys === item.default}, 'Сбросить');
    reset.onclick = () => send('hotkeys.reset', {id:item.id});
    const available = bridge.available('hotkeys.set');
    keyButton.disabled = !available.enabled; keyButton.title = available.enabled ? '' : available.reason;
    return h('div', {class:'hotkey-row'}, h('span', {}, item.label), keyButton, reset,
      h('small', {class:'hotkey-warning'}, warning));
  }
  function render(force = false) {
    const state = bridge.state;
    const next = JSON.stringify([state.hotkeys, state.settings, capturing, bridge.busy]);
    if (!force && next === signature) return;
    signature = next;
    const items = state.hotkeys || [];
    table.replaceChildren(...items.map(item => row(item, items)));
    if (!items.length) table.append(h('p', {class:'hint'}, 'Хоткеев пока нет.'));
    const settings = state.settings || {};
    const field = (key, label) => h('label', {class:'control'}, h('span', {}, label),
      h('input', {type:'text', value:settings[key] || '', readonly:true, 'aria-label':label}));
    paths.replaceChildren(field('gamePath', 'Папка игры'), field('dataPath', 'Данные хелпера'));
  }
  bridge.subscribe(() => render());
}
