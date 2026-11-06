const items = [
  {id:'medkit_small', name:{en:'Small Medkit', ru:'Малая аптечка'}, aliases:['аптечка','хилка'], group:'Медицина'},
  {id:'rope', name:{en:'Rope', ru:'Верёвка'}, aliases:['канат'], group:'Материалы'},
  {id:'iron_ingot', name:{en:'Iron Ingot', ru:'Железный слиток'}, aliases:['железо'], group:'Материалы'},
  {id:'torch', name:{en:'Torch', ru:'Факел'}, aliases:['свет'], group:'Инструменты'}
];
export function entries() {return items}
export function register(ctx, config) {
  for (const category of config.cheats || []) for (const item of category.controls || [])
    if (item.type === 'pick') ctx.state.availability['cheat:' + item.id] = {enabled:true};
}
