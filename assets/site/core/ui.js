export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (['hidden','checked','disabled','value'].includes(key)) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  node.append(...children.flat(Infinity).filter(c => c !== null && c !== undefined));
  return node;
}
let toastTimer;
export function notify(text) {
  const node = document.getElementById('toast');
  node.textContent = text; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => node.hidden = true, 4500);
}
export const num = value => Number(value).toLocaleString('ru-RU', {maximumFractionDigits:2});
export const heading = (title, ...controls) => h('div', {class:'page-heading'}, h('h1', {}, title), h('div', {class:'inline wrap'}, controls));
export function allowed(bridge, command, node) {
  return bridge.subscribe(() => {
    const item = bridge.available(command);
    node.disabled = !item.enabled;
    node.title = item.enabled ? '' : item.reason;
  });
}
export function commandButton(label, command, context, args = () => ({}), kind = '') {
  const button = h('button', {type:'button', class:kind}, label);
  button.addEventListener('click', async () => {
    try {const value = args(); if (value !== null) await context.bridge.call(command, value)} catch (error) {notify(error.message)}
  });
  if (context.transient) {
    const item = context.bridge.available(command); button.disabled = !item.enabled; button.title = item.enabled ? '' : item.reason;
  } else allowed(context.bridge, command, button);
  return button;
}
export function toggle({label, hint, command, key, read, context, availability}) {
  const input = h('input', {type:'checkbox', class:'switch-input', 'aria-label':label});
  const root = h('label', {class:'switch-label'}, h('span', {}, label, hint ? h('kbd', {}, hint) : null), input);
  input.addEventListener('change', async () => {
    try {await context.bridge.call(command, key ? {key,value:input.checked} : {enabled:input.checked})}
    catch (error) {input.checked = !!read(context.bridge.state); notify(error.message)}
  });
  context.bridge.subscribe(state => {if (document.activeElement !== input) input.checked = !!read(state)});
  allowed(context.bridge, availability || command, input);
  return root;
}
export function range({label, hint, min, max, step = .01, unit = '', command, key, read, context, availability, logarithmic = false, display}) {
  const input = h('input', {type:'range', min:logarithmic ? 0 : min, max:logarithmic ? 1000 : max, step:logarithmic ? 1 : step, 'aria-label':label});
  const exact = h('input', {type:'number', min, max, step, 'aria-label':label + ' — точное значение', class:'range-value'});
  const suffix = h('span', {class:'unit'}, unit);
  const head = h('span', {class:'control-label'}, h('span', {}, label, hint ? h('small', {}, hint) : null), h('span', {class:'value-pair'}, exact, suffix));
  const root = h('div', {class:'control'}, head, input);
  const formatted = display ? h('output', {class:'scale-hint'}) : null;
  if (formatted) root.append(formatted);
  const fromSlider = () => logarithmic ? min * Math.pow(max/min, Number(input.value)/1000) : Number(input.value);
  const toSlider = value => logarithmic ? Math.log(Math.max(min,value)/min)/Math.log(max/min)*1000 : value;
  let pendingTimer, editing = false;
  const update = value => {
    if (!Number.isFinite(value)) return;
    exact.value = String(Math.round(value*1000)/1000); input.value = toSlider(value);
    if (formatted) formatted.textContent = display(value);
  };
  const commit = value => {
    clearTimeout(pendingTimer); editing = true;
    pendingTimer = setTimeout(async () => {
      try {await context.bridge.call(command, key ? {key,value} : {value})}
      catch (error) {notify(error.message)}
      finally {editing = false; update(read(context.bridge.state))}
    }, 130);
  };
  input.addEventListener('input', () => {const value = fromSlider(); update(value); commit(value)});
  const exactInput = event => {
    if (!exact.checkValidity()) {if (event.type === 'change') exact.reportValidity(); return}
    const value = Number(exact.value); update(value); commit(value);
  };
  exact.addEventListener('input', exactInput);
  exact.addEventListener('change', exactInput);
  context.bridge.subscribe(state => {
    if (!editing && !root.contains(document.activeElement)) update(read(state));
  });
  allowed(context.bridge, availability || command, input);
  allowed(context.bridge, availability || command, exact);
  return root;
}
export function inputDialog(title, initial = '') {
  return new Promise(resolve => {
    const input = h('input', {type:'text', value:initial, required:true, maxlength:120, 'aria-label':title});
    const cancel = h('button', {type:'button'}, 'Отмена');
    const form = h('form', {}, h('h2', {}, title), input,
      h('div', {class:'inline dialog-actions'}, cancel, h('button', {type:'submit', class:'primary'}, 'Сохранить')));
    const dialog = h('dialog', {}, form); let result = null;
    form.addEventListener('submit', event => {event.preventDefault(); if (input.value.trim()) {result = input.value.trim(); dialog.close()}});
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {dialog.remove(); resolve(result)}, {once:true});
    document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  });
}
export function imageDialog(url, name) {
  const close = h('button', {class:'dialog-close', 'aria-label':'Закрыть'}, '×');
  const dialog = h('dialog', {class:'image-dialog'}, close, h('img', {src:url, alt:name}));
  close.onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
}
export function safeImageUrl(url) {
  if (!url) return '';
  if (/^data:image\/(png|jpeg|webp|svg\+xml)[;,]/i.test(url)) return url;
  try {const parsed = new URL(url, location.href); return parsed.origin === location.origin ? parsed.href : ''} catch {return ''}
}
