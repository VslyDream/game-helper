export function register(ctx) {
  const {state} = ctx;
  state.snapshots ||= {playthroughs:['Основное','Съёмка'], items:[
    {id:ctx.id(),name:'Перед сценой',createdAt:ctx.now(),playthrough:'Съёмка',scene:'Демосцена',imageUrl:ctx.image(0),deleted:false},
    {id:ctx.id(),name:'Удачный ракурс',createdAt:new Date(Date.now()-60000).toISOString(),playthrough:'Основное',scene:'Демосцена',imageUrl:ctx.image(1),deleted:false}
  ]};
  const get = id => {const item = state.snapshots.items.find(item => item.id === id); if (!item) throw new Error('Снимок не найден.'); return item};
  ctx.on('snapshots.capture', ({playthrough}) => {
    const chosen = playthrough || 'Основное';
    if (!state.snapshots.playthroughs.includes(chosen)) state.snapshots.playthroughs.push(chosen);
    state.snapshots.items.unshift({id:ctx.id(),name:'Новый момент',createdAt:ctx.now(),playthrough:chosen,scene:'Демосцена',imageUrl:ctx.image(state.snapshots.items.length),deleted:false});
  });
  ctx.on('snapshots.load', ({id}) => {get(id)});
  ctx.on('snapshots.rename', ({id,name}) => {get(id).name = name});
  ctx.on('snapshots.trash', ({id}) => {get(id).deleted = true});
  ctx.on('snapshots.restore', ({id}) => {get(id).deleted = false});
  ctx.on('snapshots.newPlaythrough', ({name}) => {if (!state.snapshots.playthroughs.includes(name)) state.snapshots.playthroughs.push(name)});
  ctx.on('snapshots.export', ({id}) => ({download:{fileName:'snapshot-demo.json',url:'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({format:'game-helper-demo-snapshot',item:get(id)}))}}));
  ctx.on('snapshots.import', ({data}) => {
    let value;
    try {
      const encoded = data.split(',')[1];
      value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))));
    } catch {throw new Error('В деморежиме импортируется только экспортированный демоснимок.')}
    if (value.format !== 'game-helper-demo-snapshot' || typeof value.item?.name !== 'string' || typeof value.item.createdAt !== 'string') throw new Error('Некорректный демоснимок.');
    state.snapshots.items.unshift({...value.item,id:ctx.id(),deleted:false});
  });
}
