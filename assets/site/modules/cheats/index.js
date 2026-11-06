import {h, heading, range, commandButton, allowed, notify} from '../../core/ui.js';

export function mount(parent, context) {
  parent.append(heading('Читы'));
  const grid = h('div', {class:'cheat-grid'});
  parent.append(grid);
  for (const category of context.config.cheats || []) {
    if (!category.controls?.length) continue;
    const controls = h('div', {class:'control-grid'});
    const panel = h('section', {class:'panel cheat-panel', id:'cheats-' + category.id}, h('h2', {}, category.title), controls);
    for (const item of category.controls) {
      const read = state => state.cheats?.[item.id] ?? item.value;
      const command = item.type === 'action' ? 'cheat.run' : 'cheat.set';
      // Per-control capability avoids pretending every declared cheat is implemented.
      const capability = 'cheat:' + item.id;
      const send = async value => {try {await context.bridge.call(command, {id:item.id,value})} catch (error) {notify(error.message)}};
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
        input.onchange = () => send(input.checked);
        context.bridge.subscribe(state => {if (document.activeElement !== input) input.checked = !!read(state)});
        allowed(context.bridge, capability, input);
        controls.append(h('label', {class:'switch-label'}, h('span', {}, item.label, item.hint ? h('kbd', {}, item.hint) : null), input));
      } else if (item.type === 'select') {
        const select = h('select', {'aria-label':item.label}, (item.options || []).map(option => h('option', {value:option.value}, option.label)));
        select.onchange = () => send(select.value);
        context.bridge.subscribe(state => {if (document.activeElement !== select && read(state) !== undefined) select.value = read(state)});
        allowed(context.bridge, capability, select);
        controls.append(h('label', {class:'control'}, h('span', {}, item.label, item.hint ? h('kbd', {}, item.hint) : null), select));
      } else if (item.type === 'pick') {
        if (context.pick) controls.append(context.pick(item, context, capability));
      } else if (item.type === 'action') {
        const count = item.count ? h('input', {type:'number', ...item.count, 'aria-label':item.count.label || 'Количество'}) : null;
        const local = {...context, bridge:{subscribe:fn => context.bridge.subscribe(fn), available:() => context.bridge.available(capability),call:(...args) => context.bridge.call(...args)}};
        const button = commandButton(item.label, command, local, () => {
          if (count && !count.checkValidity()) {count.reportValidity(); return null}
          return {id:item.id, values:count ? {count:Number(count.value)} : {}};
        });
        if (count) allowed(context.bridge, capability, count);
        controls.append(h('div', {class:'inline'}, count, button));
      }
    }
    grid.append(panel);
  }
  return grid;
}
