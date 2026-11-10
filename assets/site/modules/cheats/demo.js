export function register(ctx, config) {
  ctx.state.cheats ||= {};
  const categories = [...(config.cheats || []), ...(config.modules.includes('staging') ? config.staging?.sections || [] : [])];
  for (const category of categories) for (const item of category.controls || []) {
    ctx.state.cheats[item.id] ??= item.value;
    ctx.state.availability['cheat:' + item.id] = {enabled:true};
  }
  ctx.on('cheat.set', ({id,value}) => {ctx.state.cheats[id] = value});
  ctx.on('cheat.run', () => {});
}
