export function register(ctx, config) {
  ctx.state.staging ||= {prepare:false};
  const keys = config?.staging?.actionHotkey;
  if (keys && ctx.state.hotkeys && !ctx.state.hotkeys.some(item => item.id === 'staging.action')) ctx.state.hotkeys.push({id:'staging.action',label:'Мотор',keys,default:keys});
  ctx.on('staging.prepare', ({enabled}) => {ctx.state.staging.prepare = !!enabled});
  ctx.on('staging.action', () => {ctx.state.staging.prepare = false});
}
