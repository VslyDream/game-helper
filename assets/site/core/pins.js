import {h, notify} from './ui.js';

// UI-18. «📌 Закреплённое»: toggles and one-shot actions from any page, pinned to the sidebar.
// Pages register what can be pinned; the list itself is user data (adapter `pins.set`, else this browser).
const LIMIT = 8;

export function createPins(context, container) {
  const {bridge, config} = context;
  const defs = new Map(), resolvers = new Map(), buttons = new Set();
  const storageKey = 'game-helper:' + config.id + ':pins';
  let local = [];
  try {local = JSON.parse(localStorage.getItem(storageKey)) || []} catch {}
  const viaAdapter = () => !!bridge.state.availability?.['pins.set'];
  const list = () => (viaAdapter() ? bridge.state.pins : local) || [];
  const find = key => list().find(item => item.key === key);
  const resolve = key => defs.get(key) || resolvers.get(key.split(':')[0])?.(key, bridge.state) || null;

  async function save(next) {
    if (viaAdapter()) {
      try {await bridge.call('pins.set', {items:next})} catch (error) {notify(error.message)}
    } else {
      local = next;
      try {localStorage.setItem(storageKey, JSON.stringify(next))} catch {}
    }
    render(true);
  }
  function toggle(key) {
    const current = list();
    if (find(key)) return save(current.filter(item => item.key !== key));
    if (current.length >= LIMIT) {notify('Закрепить можно не больше ' + LIMIT + ' действий.'); return}
    const def = resolve(key);
    const values = def?.capture?.();
    return save([...current, values && Object.keys(values).length ? {key, values} : {key}]);
  }
  // A small pin switch placed next to the control on its own page; visible on hover/focus or when pinned.
  function button(key) {
    const node = h('button', {type:'button', class:'pin-toggle', 'data-pin':key}, '📌');
    node.onclick = event => {event.preventDefault(); event.stopPropagation(); toggle(key)};
    buttons.add(node); paintButton(node);
    return node;
  }
  function paintButton(node) {
    const pinned = !!find(node.dataset.pin);
    node.setAttribute('aria-pressed', String(pinned));
    const label = (pinned ? 'Открепить из меню: ' : 'Закрепить в меню: ') + (resolve(node.dataset.pin)?.label || '');
    node.title = label; node.setAttribute('aria-label', label);
  }

  let signature = '', updaters = [];
  function render(force = false) {
    const items = list().map(item => ({item, def:resolve(item.key)})).filter(entry => entry.def);
    const next = JSON.stringify(items.map(({item, def}) => [item.key, item.values, def.label, def.hint]));
    for (const node of buttons) node.isConnected ? paintButton(node) : buttons.delete(node);
    if (!force && next === signature) return;
    signature = next; updaters = [];
    container.hidden = !items.length;
    const rows = items.map(({item, def}, index) => row(item, def, index));
    container.replaceChildren(h('div', {class:'pins-title'}, '📌 Закреплённое'), h('ul', {class:'pins-list'}, rows));
    for (const update of updaters) update(bridge.state);
  }
  function row(item, def, index) {
    const unpin = h('button', {type:'button', class:'pin-remove', title:'Открепить', 'aria-label':'Открепить: ' + def.label}, '×');
    unpin.onclick = () => toggle(item.key);
    const binding = def.hotkey && bridge.state.hotkeys?.find(entry => entry.id === def.hotkey);
    const keys = binding ? [binding.keys, binding.gamepadKeys?.replaceAll('+',' + ')].filter(Boolean).join(' · ') : def.hint || '';
    const hint = keys || def.hotkey ? h('kbd', {'data-hotkey':def.hotkey || null, hidden:!keys}, keys) : null;
    let control, body;
    const availability = () => {
      const state = bridge.available(def.capability);
      control.disabled = !state.enabled; control.title = state.enabled ? '' : state.reason;
    };
    if (def.kind === 'toggle') {
      control = h('input', {type:'checkbox', class:'switch-input', 'aria-label':def.label});
      control.onchange = async () => {
        try {await def.set(control.checked)}
        catch (error) {control.checked = !!def.read(bridge.state); notify(error.message)}
      };
      updaters.push(state => {if (document.activeElement !== control) control.checked = !!def.read(state); availability()});
      body = h('label', {class:'pin-row switch-label'}, h('span', {}, def.label, hint), control);
    } else {
      const count = item.values?.count;
      control = h('button', {type:'button', class:'pin-action' + (def.primary ? ' primary' : '')}, def.label, count ? ' ×' + count : '', hint);
      control.onclick = async () => {try {await def.run(item.values)} catch (error) {notify(error.message)}};
      updaters.push(availability);
      body = control;
    }
    const li = h('li', {class:'pin-item', draggable:'true'}, body, unpin);
    li.ondragstart = event => {event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging')};
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = event => {event.preventDefault(); li.classList.add('drop')};
    li.ondragleave = () => li.classList.remove('drop');
    li.ondrop = event => {
      event.preventDefault(); li.classList.remove('drop');
      const from = Number(event.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(from) || from === index) return;
      const next = [...list()]; const [moved] = next.splice(from, 1); next.splice(index, 0, moved);
      save(next);
    };
    return li;
  }
  bridge.subscribe(state => {render(); for (const update of updaters) update(state)});

  return {
    // def: {key,label,kind:'toggle'|'action',capability, read/set for toggle, run/capture for action, hint, hotkey, primary}
    register(def) {defs.set(def.key, def); return button(def.key)},
    resolver(prefix, fn) {resolvers.set(prefix, fn)},
    button,
    toggle,
    isPinned:key => !!find(key),
    render:() => render(true)
  };
}
