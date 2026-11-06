import {h, heading, commandButton, inputDialog, imageDialog, safeImageUrl, notify} from '../../core/ui.js';

export function mount(parent, context) {
  const {bridge, config} = context;
  const storageKey = 'game-helper:' + config.id + ':gallery-filter';
  let selected = 'all', tag = '', signature = '', trashDialog;
  try {selected = localStorage.getItem(storageKey) || 'all'} catch {}
  const filter = h('select', {'aria-label':'Прохождение'});
  const gallery = h('div', {class:'gallery'});
  const chips = h('div', {class:'chip-filter', hidden:true});
  const trashCount = h('span', {}, '0');
  const trash = h('button', {type:'button'}, 'Корзина ', trashCount);
  const newPlaythrough = commandButton('＋ Прохождение', 'snapshots.newPlaythrough', context, () => null, 'quiet');
  newPlaythrough.addEventListener('click', async () => {
    const name = await inputDialog('Новое прохождение');
    if (name) try {await bridge.call('snapshots.newPlaythrough', {name}); selected = name; render(true)} catch (error) {notify(error.message)}
  });
  const importFile = h('input', {type:'file',hidden:true});
  const importButton = commandButton('Импорт', 'snapshots.import', context, () => null);
  importButton.addEventListener('click', () => importFile.click());
  importFile.onchange = async () => {
    const file = importFile.files[0]; if (!file) return;
    const maxBytes = config.snapshots?.maxImportBytes || 64*1024*1024;
    if (file.size > maxBytes) {notify('Файл превышает допустимый размер импорта.'); importFile.value = ''; return}
    const data = await new Promise((resolve,reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file)}).catch(() => null);
    if (data) try {await bridge.call('snapshots.import', {fileName:file.name,data})} catch (error) {notify(error.message)}
    importFile.value = '';
  };
  parent.append(
    heading('Сохранения', commandButton('↻ Дубль заново', 'snapshots.retake', context, () => ({})), commandButton('＋ Снять и сохранить', 'snapshots.capture', context, () => ({playthrough:selected === 'all' ? 'Основное' : selected}), 'primary')),
    h('div', {class:'gallery-toolbar'}, h('div', {class:'inline'}, filter, newPlaythrough), h('div', {class:'inline'}, importButton, trash)),
    chips, importFile, gallery
  );
  filter.onchange = () => {selected = filter.value; try {localStorage.setItem(storageKey, selected)} catch {} render(true)};
  function action(label, suffix, args, after) {
    const command = 'snapshots.' + suffix;
    const button = h('button', {type:'button'}, label);
    const availability = bridge.available(command);
    button.disabled = !availability.enabled; button.title = availability.enabled ? '' : availability.reason;
    button.onclick = async () => {
      try {const value = await args(); if (value !== null) {const result = await bridge.call(command, value); after?.(result)}} catch (error) {notify(error.message)}
    };
    return button;
  }
  function download(result) {
    const url = result.download?.url;
    if (!url) {notify('Сервис не вернул файл экспорта.'); return}
    const parsed = new URL(url, location.href);
    if (parsed.origin !== location.origin && !(config.demo && url.startsWith('data:application/json'))) {notify('Некорректный адрес экспорта.'); return}
    const link = h('a', {href:url,download:result.download.fileName || 'snapshot.zip'});
    document.body.append(link); link.click(); link.remove();
  }
  function card(item) {
    const url = safeImageUrl(item.imageUrl);
    const image = url ? h('img', {class:'snapshot-image',src:url,alt:item.name,tabindex:0}) : h('div', {class:'snapshot-image empty-image'}, 'Кадр недоступен');
    if (url) {image.onclick = () => imageDialog(url,item.name); image.onkeydown = event => {if (event.key === 'Enter') imageDialog(url,item.name)}}
    const menu = h('details', {class:'card-menu'}, h('summary', {'aria-label':'Действия: ' + item.name}, '•••'),
      h('div', {},
        action('Название', 'rename', async () => {const name = await inputDialog('Название снимка', item.name); return name ? {id:item.id,name} : null}),
        action('Экспорт', 'export', () => ({id:item.id}), download),
        action('В корзину', 'trash', () => ({id:item.id}))));
    const date = new Date(item.createdAt);
    const info = [Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('ru-RU'), item.scene, item.playthrough].filter(Boolean).join(' · ');
    const load = action('Загрузить', 'load', () => ({id:item.id})); load.classList.add('primary');
    const tags = item.tags?.length ? h('div', {class:'chips'}, item.tags.map(t => h('span', {class:'chip'}, t))) : null;
    const check = item.check && !item.check.ok ? h('p', {class:'snapshot-check'}, '⚠ ' + (item.check.message || 'Проверка не прошла')) : null;
    return h('article', {class:'snapshot'}, image, h('div', {class:'snapshot-body'}, h('h3', {}, item.name), h('p', {class:'hint'}, info), tags, check, h('div', {class:'inline spread'}, load, menu)));
  }
  function renderTrash() {
    if (!trashDialog) return;
    const close = h('button', {type:'button'}, 'Закрыть'); close.onclick = () => trashDialog.close();
    const items = bridge.state.snapshots?.items?.filter(s => s.deleted) || [];
    trashDialog.replaceChildren(h('div', {class:'panel-head'}, h('h2', {}, 'Корзина снимков'), close),
      ...items.map(item => h('div', {class:'trash-row'}, h('span', {}, item.name), action('Восстановить', 'restore', () => ({id:item.id})))),
      items.length ? '' : h('p', {class:'hint'}, 'Корзина пуста.'));
  }
  trash.onclick = () => {
    trashDialog = h('dialog', {class:'trash-dialog'}); renderTrash();
    trashDialog.onclose = () => {trashDialog.remove(); trashDialog = null};
    document.body.append(trashDialog); trashDialog.showModal();
  };
  function render(force = false) {
    const data = bridge.state.snapshots || {items:[],playthroughs:[]};
    const nextSignature = JSON.stringify([data,bridge.state.availability,bridge.busy,selected,tag]);
    if (!force && signature === nextSignature) return;
    signature = nextSignature;
    const names = [...new Set([...(data.playthroughs || []), ...(data.items || []).map(s => s.playthrough)].filter(Boolean))];
    filter.replaceChildren(h('option', {value:'all'}, 'Все прохождения'), ...names.map(name => h('option', {value:name}, name)));
    filter.value = selected;
    if (!filter.value) {selected = 'all'; filter.value = 'all'}
    const allTags = [...new Set((data.items || []).filter(s => !s.deleted).flatMap(s => s.tags || []))];
    if (tag && !allTags.includes(tag)) tag = '';
    chips.hidden = !allTags.length;
    chips.replaceChildren(...allTags.map(name => {
      const button = h('button', {type:'button', class:'chip' + (name === tag ? ' active' : ''), 'aria-pressed':String(name === tag)}, name);
      button.onclick = () => {tag = tag === name ? '' : name; render(true)};
      return button;
    }));
    const items = (data.items || []).filter(s => !s.deleted && (selected === 'all' || s.playthrough === selected) && (!tag || s.tags?.includes(tag))).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    gallery.replaceChildren(...items.map(card));
    if (!items.length) gallery.append(h('p', {class:'hint'}, 'Пока нет снимков.'));
    trashCount.textContent = (data.items || []).filter(s => s.deleted).length;
    renderTrash();
  }
  bridge.subscribe(() => render());
}
