export function register(ctx) {
  ctx.state.staging ||= {prepare:false};
  ctx.on('staging.prepare', ({enabled}) => {ctx.state.staging.prepare = !!enabled});
  ctx.on('staging.action', () => {ctx.state.staging.prepare = false});
}
