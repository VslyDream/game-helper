import {h, heading, commandButton, allowed, inputDialog, imageDialog, safeImageUrl, num, notify} from '../../core/ui.js';

const time = value => Math.floor((value || 0)/60) + ':' + String(Math.floor((value || 0)%60)).padStart(2,'0');
export function mount(parent, context) {
  document.head.append(h('link', {rel:'stylesheet',href:'./modules/replays/style.css'}));
  const {bridge, config} = context;
  const kinds = [];
  if (config.modules.includes('replay-camera')) kinds.push({id:'camera',label:'🎥 Камера'});
  if (config.modules.includes('replay-players')) kinds.push({id:'players',label:'👥 Игроки и действия'});
  const kind = h('select', {'aria-label':'Тип записи'}, kinds.map(k => h('option', {value:k.id}, k.label)));
  const controls = h('section', {class:'panel replay-controls'});
  const record = commandButton('● Начать запись', 'replays.record', context, () => ({kind:kind.value}));
  const pause = commandButton('Пауза', 'replays.pause', context);
  const stop = commandButton('Завершить', 'replays.stop', context);
  const play = commandButton('▶ Начать', 'replays.play', context, () => ({}), 'primary');
  const restart = commandButton('↶ Сначала', 'replays.restart', context);
  const stateLabel = h('span', {class:'hint replay-state'});
  const speed = h('input', {type:'range',min:.1,max:4,step:.1,value:1,'aria-label':'Скорость повтора'});
  const speedValue = h('output', {}, '×1');
  const timeline = h('input', {type:'range',min:0,max:1,step:.01,value:0,'aria-label':'Таймлайн повтора'});
  const timelineValue = h('output', {}, '0:00 / 0:00');
  const timelineHint = h('p', {class:'hint'});
  const observer = h('input', {type:'checkbox','aria-label':'Свободная камера в повторе'});
  const observerLabel = h('label', {class:'inline',hidden:!config.modules.includes('freecam')}, observer, '🎥 Свободная камера');
  const tracks = h('div', {class:'tracks'});
  const gallery = h('div', {class:'gallery replay-gallery'});
  const trashCount = h('span', {}, '0');
  const trash = h('button', {}, 'Корзина ', trashCount);
  // REPLAY-23. Look presets: a named camera/optics/view-cheats state, applied in one click without recording.
  const hasLooks = config.modules.includes('replay-camera');
  const looks = h('div', {class:'looks'});
  const lookPose = h('input', {type:'checkbox',checked:true});
  const lookSave = commandButton('＋ Сохранить образ', 'replays.look.save', context, () => null);
  const lookPanel = h('section', {class:'panel replay-looks',hidden:true},
    h('div', {class:'panel-head'}, h('h2', {}, 'Образы'), h('div', {class:'inline'}, h('label', {class:'inline look-pose'}, lookPose, 'с ракурсом'), lookSave)), looks);
  parent.append(heading('Записи и повторы', trash), controls, lookPanel, tracks, gallery);
  controls.append(
    h('div', {class:'inline wrap'}, kinds.length > 1 ? kind : h('span', {}, kinds[0].label), record, pause, stop, stateLabel),
    h('div', {class:'inline wrap playback-row'}, play, restart, observerLabel,
      h('label', {class:'replay-speed-label'}, 'Скорость', speed, speedValue)),
    h('div', {class:'timeline-row'}, h('span', {}, 'Таймлайн'), timeline, timelineValue), timelineHint,
    h('p', {class:'hint hotkeys'}, h('kbd', {}, 'F6'), ' запись/пауза · ', h('kbd', {}, 'F7'), ' повтор/пауза · ', h('kbd', {}, 'F8'), ' завершить'));
  const send = async (command,args) => {try {return await bridge.call('replays.' + command,args)} catch (error) {notify(error.message)}};
  speed.oninput = () => speedValue.textContent = '×' + num(speed.value);
  speed.onchange = () => send('speed', {value:Number(speed.value)});
  timeline.oninput = () => timelineValue.textContent = time(Number(timeline.value)) + ' / ' + time(bridge.state.replays?.duration);
  timeline.onchange = () => send('seek', {time:Number(timeline.value)});
  observer.onchange = () => send('observer', {enabled:observer.checked});
  lookSave.addEventListener('click', async () => {
    const camera = bridge.state.freecam || {};
    const name = await inputDialog('Название образа', [camera.fov ? 'FOV ' + num(camera.fov) : '', camera.aperture ? 'f/' + num(camera.aperture) : ''].filter(Boolean).join(', '));
    if (name) send('look.save', {name,pose:lookPose.checked});
  });
  // Partial apply is a success: the adapter names what it skipped (REPLAY-27).
  const applyLook = async (item, pose = true) => {
    const result = await bridge.call('replays.look.apply', {id:item.id,pose:pose && !!item.pose});
    if (result?.skipped?.length) notify('Применено без: ' + result.skipped.join(', '));
  };
  const pins = hasLooks ? context.pins : null;
  pins?.resolver('look', key => {
    const item = bridge.state.replays?.looks?.find(look => 'look:' + look.id === key);
    return item ? {key, label:'🎨 ' + item.name, kind:'action', capability:'replays.look.apply', run:() => applyLook(item)} : null;
  });
  allowed(bridge,'replays.speed',speed);
  allowed(bridge,'replays.observer',observer);
  let gallerySignature = '', tracksSignature = '', looksSignature = '', trashDialog;
  function action(label, command, args) {
    return commandButton(label, 'replays.' + command, {...context,transient:true}, args);
  }
  function renderTrash() {
    if (!trashDialog) return;
    const items = bridge.state.replays?.items?.filter(item => item.deleted) || [];
    const close = h('button', {}, 'Закрыть'); close.onclick = () => trashDialog.close();
    trashDialog.replaceChildren(h('div', {class:'panel-head'}, h('h2', {}, 'Корзина повторов'), close),
      ...items.map(item => h('div', {class:'trash-row'}, item.name, action('Восстановить','restore',() => ({id:item.id})))),
      items.length ? '' : h('p', {class:'hint'}, 'Корзина пуста.'));
  }
  function renderLooks(data, state, force = false) {
    const items = hasLooks ? data.looks || [] : [];
    const next = JSON.stringify([items,bridge.busy,state.availability]);
    if (!force && next === looksSignature) return;
    looksSignature = next;
    lookPanel.hidden = !hasLooks || !(items.length || state.availability?.['replays.look.save']);
    const available = bridge.available('replays.look.apply');
    looks.replaceChildren(...items.map(item => {
      const apply = h('button', {type:'button',class:'look-apply',disabled:!available.enabled,title:available.enabled ? item.summary || '' : available.reason}, item.name);
      apply.onclick = () => applyLook(item).catch(error => notify(error.message));
      const still = item.pose ? h('button', {type:'button',disabled:!available.enabled}, 'Без перемещения') : null;
      if (still) still.onclick = () => applyLook(item,false).catch(error => notify(error.message));
      const rename = action('Название','look.rename',() => null);
      rename.addEventListener('click', async () => {const name = await inputDialog('Название образа',item.name); if (name) send('look.rename',{id:item.id,name})});
      const pin = pins ? h('button', {type:'button'}, pins.isPinned('look:' + item.id) ? '📌 Открепить из меню' : '📌 Закрепить в меню') : null;
      if (pin) pin.onclick = async () => {await pins.toggle('look:' + item.id); renderLooks(bridge.state.replays || {},bridge.state,true)};
      return h('span', {class:'look'}, apply, h('details', {class:'card-menu'}, h('summary', {'aria-label':'Действия: ' + item.name}, '•••'),
        h('div', {}, still, rename, pin, action('Удалить','look.delete',() => ({id:item.id})))));
    }));
    if (!items.length) looks.append(h('p', {class:'hint'}, 'Пока нет образов.'));
  }
  trash.onclick = () => {
    trashDialog = h('dialog', {class:'trash-dialog'}); renderTrash();
    trashDialog.onclose = () => {trashDialog.remove(); trashDialog = null};
    document.body.append(trashDialog); trashDialog.showModal();
  };
  bridge.subscribe(state => {
    const data = state.replays || {items:[],status:'idle',tracks:[]};
    const status = data.status || 'idle';
    const labels = {idle:'Выберите запись',loaded:'Загружено · старт в паузе',recording:'Идёт запись',playing:'Идёт повтор',paused:'Пауза',finished:'Повтор завершён'};
    stateLabel.textContent = labels[status] || status;
    record.disabled = !bridge.available('replays.record').enabled || status !== 'idle';
    kind.disabled = status !== 'idle';
    pause.disabled = !bridge.available('replays.pause').enabled || !['playing','recording','paused'].includes(status);
    pause.textContent = status === 'paused' ? 'Продолжить' : 'Пауза';
    play.disabled = !bridge.available('replays.play').enabled || !data.selectedId || !['loaded','paused','finished'].includes(status) || data.recording;
    play.textContent = status === 'paused' ? '▶ Продолжить' : '▶ Начать';
    restart.disabled = !bridge.available('replays.restart').enabled || !data.selectedId || data.recording;
    stop.disabled = !bridge.available('replays.stop').enabled || status === 'idle';
    timeline.disabled = !bridge.available('replays.seek').enabled || !data.canSeek || !data.selectedId || data.recording;
    if (document.activeElement !== speed) speed.value = data.speed || 1;
    speedValue.textContent = '×' + num(speed.value);
    timeline.max = data.duration || 1;
    if (document.activeElement !== timeline) {timeline.value = data.time || 0; timelineValue.textContent = time(data.time) + ' / ' + time(data.duration)}
    if (document.activeElement !== observer) observer.checked = !!data.observer;
    observerLabel.hidden = !config.modules.includes('freecam') || data.kind !== 'players';
    timelineHint.textContent = data.kind === 'players' && !data.canSeek ? 'Таймлайн показывает прогресс. «Сначала» восстанавливает исходный мир.' : '';
    timelineHint.hidden = !timelineHint.textContent;
    const nextTracks = JSON.stringify([data.tracks,data.kind,data.selectedId,bridge.busy,state.availability]);
    if (nextTracks !== tracksSignature) {
      tracksSignature = nextTracks; tracks.hidden = data.kind !== 'players' || !data.selectedId;
      tracks.replaceChildren(...(data.tracks || []).map(track => {
        const enabled = h('input', {type:'checkbox',checked:track.enabled,'aria-label':'Дорожка: ' + track.name});
        const actions = h('input', {type:'checkbox',checked:track.actions,'aria-label':'Действия: ' + track.name});
        enabled.onchange = () => send('track',{id:track.id,enabled:enabled.checked,actions:track.actions});
        actions.onchange = () => send('track',{id:track.id,enabled:track.enabled,actions:actions.checked});
        const available = bridge.available('replays.track'); enabled.disabled = actions.disabled = !available.enabled;
        return h('div', {class:'replay-track'}, track.name, h('label', {}, enabled,' Дорожка'), h('label', {}, actions,' Действия'), action('Перезаписать','overdub',() => ({id:track.id})));
      }), action('＋ Добавить игрока','addTrack',() => ({})));
    }
    renderLooks(data,state);
    const nextGallery = JSON.stringify([data.items,bridge.busy,state.availability]);
    if (nextGallery === gallerySignature) return;
    gallerySignature = nextGallery;
    const items = (data.items || []).filter(item => !item.deleted).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    gallery.replaceChildren(...items.map(item => {
      const url = safeImageUrl(item.imageUrl);
      const image = url ? h('img', {src:url,alt:item.name,class:'snapshot-image',tabindex:0}) : h('div', {class:'snapshot-image empty-image'}, 'Кадр недоступен');
      if (url) {image.onclick = () => imageDialog(url,item.name); image.onkeydown = event => {if (event.key === 'Enter') imageDialog(url,item.name)}}
      const rename = action('Название','rename',() => null);
      rename.addEventListener('click', async () => {const name = await inputDialog('Название повтора',item.name); if (name) send('rename',{id:item.id,name})});
      const menu = h('details', {class:'card-menu'}, h('summary', {'aria-label':'Действия: ' + item.name}, '•••'),
        h('div', {}, rename, action('В корзину','trash',() => ({id:item.id}))));
      const load = action('Загрузить','load',() => ({id:item.id})); load.classList.add('primary');
      return h('article', {class:'snapshot'}, image, h('div', {class:'snapshot-body'}, h('h3', {}, item.name),
        h('p', {class:'hint'}, time(item.duration) + ' · ' + (item.kind === 'players' ? 'Игроки' : 'Камера')),
        h('div', {class:'inline spread'}, load, menu)));
    }));
    if (!items.length) gallery.append(h('p', {class:'hint'}, 'Пока нет повторов.'));
    trashCount.textContent = (data.items || []).filter(item => item.deleted).length;
    renderTrash();
  });
}
