import {h, heading, range, commandButton, allowed, notify} from '../../core/ui.js';

// One category of controls from config (cheats or another page's sections).
export function renderCategory(category, context, idPrefix = 'cheats-') {
  const controls = h('div', {class:'control-grid'});
  const panel = h('section', {class:'panel cheat-panel', id:idPrefix + category.id}, h('h2', {}, category.title), controls);
  for (const item of category.controls || []) {
    const read = state => state.cheats?.[item.id] ?? item.value;
    const command = item.type === 'action' ? 'cheat.run' : 'cheat.set';
    // Per-control capability avoids pretending every declared cheat is implemented.
    const capability = 'cheat:' + item.id;
    // «hotkey» in config.json names the adapter hotkey whose current keys the badge shows (default: the control id).
    const badge = item.hint ? h('kbd', {'data-hotkey':item.hotkey || item.id}, item.hint) : null;
    const pin = kind => context.pins?.register({key:'cheat:' + item.id, label:item.label, kind, hotkey:item.hotkey || item.id, hint:item.hint, capability,
      read, set:value => context.bridge.call('cheat.set', {id:item.id, value}),
      capture:kind === 'action' ? () => count ? {count:Number(count.value)} : {} : null,
      run:values => context.bridge.call('cheat.run', {id:item.id, values:values || {}})});
    let count = null;
    if (item.type === 'range') {
      const local = {...context, bridge:{
        get state() {return context.bridge.state},
        subscribe:fn => context.bridge.subscribe(fn),
        available:key => context.bridge.available(key),
        call:(_command, args) => context.bridge.call(command, {id:item.id,value:args.value})
      }};
      controls.append(range({...item, context:local, command, availability:capability, read}));
    } else if (item.type === 'toggle') {
      const input = h('input', {type:'checkbox',class:'switch-input','aria-label':item.label});
      input.onchange = async () => {
        try {await context.bridge.call(command, {id:item.id,value:input.checked})}
        catch (error) {input.checked = !!read(context.bridge.state); notify(error.message)}
      };
      context.bridge.subscribe(state => {if (document.activeElement !== input) input.checked = !!read(state)});
      allowed(context.bridge, capability, input);
      controls.append(h('label', {class:'switch-label'}, h('span', {}, item.label, badge, pin('toggle')), input));
    } else if (item.type === 'select') {
      const select = h('select', {'aria-label':item.label}, (item.options || []).map(option => h('option', {value:option.value}, option.label)));
      select.onchange = async () => {
        try {await context.bridge.call(command, {id:item.id,value:select.value})}
        catch (error) {if (read(context.bridge.state) !== undefined) select.value = read(context.bridge.state); notify(error.message)}
      };
      context.bridge.subscribe(state => {if (document.activeElement !== select && read(state) !== undefined) select.value = read(state)});
      allowed(context.bridge, capability, select);
      controls.append(h('label', {class:'control'}, h('span', {}, item.label, badge), select));
    } else if (item.type === 'pick') {
      if (context.pick) controls.append(context.pick(item, context, capability));
    } else if (item.type === 'action') {
      count = item.count ? h('input', {type:'number', ...item.count, 'aria-label':item.count.label || 'Количество'}) : null;
      const local = {...context, bridge:{subscribe:fn => context.bridge.subscribe(fn), available:() => context.bridge.available(capability),call:(...args) => context.bridge.call(...args)}};
      const button = commandButton(item.label, command, local, () => {
        if (count && !count.checkValidity()) {count.reportValidity(); return null}
        return {id:item.id, values:count ? {count:Number(count.value)} : {}};
      });
      if (badge) button.append(badge);
      if (count) allowed(context.bridge, capability, count);
      controls.append(h('div', {class:'inline'}, count, button, pin('action')));
    }
  }
  return panel;
}

export function mount(parent, context) {
  parent.append(heading('Читы'));
  const grid = h('div', {class:'cheat-grid'});
  parent.append(grid);
  for (const category of context.config.cheats || []) {
    if (category.controls?.length) grid.append(renderCategory(category, context));
  }
  return grid;
}

// Hotkey badges anywhere in the page follow the current bindings; empty bindings hide the badge.
export function syncHotkeyBadges(root, bridge) {
  bridge.subscribe(state => {
    for (const badge of root.querySelectorAll('kbd[data-hotkey]')) {
      const binding = state.hotkeys?.find(item => item.id === badge.dataset.hotkey);
      if (!binding) continue;
      const text = [binding.keys,binding.gamepadKeys?.replaceAll('+',' + ')].filter(Boolean).join(' · ');
      badge.textContent = text; badge.hidden = !text;
    }
  });
}
