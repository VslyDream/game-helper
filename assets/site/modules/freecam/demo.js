export function register(ctx, config) {
  ctx.state.freecam = {speed:6,fov:82,sensitivity:.12,moveSmoothing:.12,lookSmoothing:.08,focusDistance:5,aperture:0,...ctx.state.freecam,enabled:false,focusLocked:false};
  ctx.on('freecam.set', ({key,value}) => {
    if (!(key in ctx.state.freecam)) throw new Error('Неизвестный параметр камеры');
    ctx.state.freecam[key] = value;
    if (key === 'focusDistance') ctx.state.freecam.focusLocked = false;
  });
  if (config.freecam?.optics !== false) for (const key of ['focusDistance','aperture','focusLocked']) ctx.state.availability['freecam.' + key] = {enabled:true};
}
