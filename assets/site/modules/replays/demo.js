export function register(ctx, config) {
  const kinds = ['camera','players'].filter(kind => config.modules.includes('replay-' + (kind === 'camera' ? 'camera' : 'players')));
  const items = kinds.map((kind,index) => ({id:ctx.id(),name:kind === 'camera' ? 'Полёт камеры' : 'Дубль сцены',kind,duration:45,createdAt:new Date(Date.now()-index*60000).toISOString(),imageUrl:ctx.image(index),deleted:false}));
  ctx.state.replays = {items,...ctx.state.replays,status:'idle',recording:false,selectedId:null,time:0,duration:0,speed:1,tracks:[],observer:false};
  const data = ctx.state.replays;
  data.items = data.items.filter(item => kinds.includes(item.kind));
  let timer, beforePause, lastTime;
  const stopTick = () => {clearInterval(timer); timer = null};
  ctx.onClose(stopTick);
  function tick() {
    stopTick(); lastTime = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      data.time += (now-lastTime)/1000*(data.recording ? 1 : data.speed); lastTime = now;
      if (data.recording) data.duration = data.time;
      else if (data.time >= data.duration) {data.time = data.duration; data.status = 'finished'; stopTick()}
      ctx.emit();
    },100);
  }
  const tracks = () => [{id:ctx.id(),name:'Игрок 1',enabled:true,actions:true},{id:ctx.id(),name:'Игрок 2',enabled:true,actions:true}];
  ctx.on('replays.load', ({id}) => {
    const item = data.items.find(item => item.id === id && !item.deleted); if (!item) throw new Error('Повтор не найден.');
    stopTick(); Object.assign(data,{selectedId:id,kind:item.kind,status:'loaded',time:0,duration:item.duration,recording:false,canSeek:item.kind === 'camera',tracks:item.kind === 'players' ? tracks() : []});
  });
  ctx.on('replays.record', ({kind}) => {if (!kinds.includes(kind)) throw new Error('Тип записи не выбран.'); Object.assign(data,{kind,status:'recording',recording:true,time:0,duration:0,selectedId:null,tracks:kind === 'players' ? tracks() : []}); tick()});
  ctx.on('replays.play', () => {if (!data.selectedId) throw new Error('Сначала загрузите повтор.'); if (data.status === 'finished') data.time = 0; data.status = 'playing'; tick()});
  ctx.on('replays.pause', () => {if (data.status === 'paused') {data.status = beforePause; tick()} else {beforePause = data.status; data.status = 'paused'; stopTick()}});
  ctx.on('replays.restart', () => {data.time = 0; data.status = 'playing'; tick()});
  ctx.on('replays.stop', () => {
    stopTick();
    if (data.recording) data.items.unshift({id:ctx.id(),name:'Новый дубль',kind:data.kind,duration:data.time,createdAt:ctx.now(),imageUrl:ctx.image(0),deleted:false});
    Object.assign(data,{status:'idle',recording:false,time:0,duration:0,selectedId:null,tracks:[]});
  });
  ctx.on('replays.seek', ({time}) => {if (!data.canSeek) throw new Error('Перемотка действий не поддержана.'); data.time = Math.max(0,Math.min(data.duration,time))});
  ctx.on('replays.speed', ({value}) => {data.speed = value});
  if (config.modules.includes('freecam')) ctx.on('replays.observer', ({enabled}) => {data.observer = enabled; ctx.state.freecam.enabled = enabled});
  ctx.on('replays.track', ({id,enabled,actions}) => {const track = data.tracks.find(track => track.id === id); if (track) Object.assign(track,{enabled,actions})});
  ctx.on('replays.addTrack', () => {data.tracks.push({id:ctx.id(),name:'Игрок ' + (data.tracks.length+1),enabled:true,actions:true})});
  ctx.on('replays.overdub', () => {data.time = 0; data.status = 'recording'; data.recording = true; tick()});
  ctx.on('replays.rename', ({id,name}) => {data.items.find(item => item.id === id).name = name});
  ctx.on('replays.trash', ({id}) => {data.items.find(item => item.id === id).deleted = true});
  ctx.on('replays.restore', ({id}) => {data.items.find(item => item.id === id).deleted = false});
}
