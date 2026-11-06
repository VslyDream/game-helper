import {h, allowed, notify, safeImageUrl} from '../../core/ui.js';

// Catalog pick control (CAT-04): search by ru/en name and aliases, optional count.
const cache = new Map();
async function load(name, config) {
  if (!cache.has(name)) cache.set(name, (async () => {
    if (config.demo) return (await import('./demo.js')).entries(name);
    const response = await fetch('./catalog/' + encodeURIComponent(name) + '.json', {cache:'no-store'});
    if (!response.ok) throw new Error('Справочник «' + name + '» не найден.');
    return response.json();
  })());
  return cache.get(name);
}
const text = entry => [entry.name?.ru, entry.name?.en, entry.id, ...(entry.aliases || [])].filter(Boolean).join(' ').toLowerCase();
const title = entry => entry.name?.ru || entry.name?.en || entry.id;

export function pickControl(item, context, capability) {
  let entries = [], chosen = null;
  const search = h('input', {type:'search', placeholder:'Поиск…', 'aria-label':item.label, autocomplete:'off'});
  const list = h('div', {class:'pick-list', role:'listbox', hidden:true});
  const count = item.count ? h('input', {type:'number', ...item.count, 'aria-label':item.count.label || 'Количество'}) : null;
  const button = h('button', {type:'button', disabled:true}, item.buttonLabel || 'Выдать');
  const choose = entry => {chosen = entry; search.value = title(entry); list.hidden = true; button.disabled = !context.bridge.available(capability).enabled};
  const show = () => {
    const query = search.value.trim().toLowerCase();
    const found = entries.filter(entry => !query || text(entry).includes(query)).slice(0, 40);
    list.replaceChildren(...found.map(entry => {
      const icon = safeImageUrl(entry.icon);
      const option = h('button', {type:'button', role:'option', class:'pick-option'},
        icon ? h('img', {src:icon, alt:''}) : h('span', {class:'pick-noicon'}), h('span', {}, title(entry)),
        entry.group ? h('small', {}, entry.group) : null);
      option.onmousedown = event => {event.preventDefault(); choose(entry)};
      return option;
    }));
    list.hidden = !found.length;
  };
  search.oninput = () => {chosen = null; button.disabled = true; show()};
  search.onfocus = show;
  search.onblur = () => {list.hidden = true};
  search.onkeydown = event => {if (event.key === 'Enter' && list.firstChild) {event.preventDefault(); list.firstChild.dispatchEvent(new MouseEvent('mousedown'))}};
  button.onclick = async () => {
    if (!chosen) return;
    if (count && !count.checkValidity()) {count.reportValidity(); return}
    try {await context.bridge.call('cheat.run', {id:item.id, values:{item:chosen.id, ...(count ? {count:Number(count.value)} : {})}})}
    catch (error) {notify(error.message)}
  };
  context.bridge.subscribe(() => {
    const state = context.bridge.available(capability);
    search.disabled = !state.enabled; search.title = state.enabled ? '' : state.reason;
    button.disabled = !state.enabled || !chosen;
  });
  if (count) allowed(context.bridge, capability, count);
  load(item.catalog, context.config).then(value => {entries = Array.isArray(value) ? value : value.items || []})
    .catch(error => {search.disabled = true; search.placeholder = error.message});
  return h('div', {class:'control pick'}, h('span', {class:'control-label'}, h('span', {}, item.label, item.hint ? h('kbd', {}, item.hint) : null)),
    h('div', {class:'pick-field'}, search, list), h('div', {class:'inline'}, count, button));
}
