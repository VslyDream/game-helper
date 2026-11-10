export const BUTTONS = ['a','b','x','y','lb','rb','lt','rt','back','start','ls','rs','up','down','left','right','guide'];
export const LABELS = {a:'A',b:'B',x:'X',y:'Y',lb:'LB',rb:'RB',lt:'LT',rt:'RT',back:'View',start:'Menu',ls:'L3',rs:'R3',up:'↑',down:'↓',left:'←',right:'→',guide:'Home'};

export function radialDeadzone(x, y, zone = 0.1) {
  zone = Math.max(0, Math.min(0.95, Number(zone) || 0));
  const length = Math.hypot(x, y);
  if (length <= zone) return [0, 0];
  const scale = Math.min(1, (length - zone) / (1 - zone)) / length;
  return [x * scale, y * scale];
}

export function browserDevice(pad) {
  const raw = {axes: Array.from(pad.axes), buttons: Array.from(pad.buttons, b => ({pressed: b.pressed, touched: b.touched, value: b.value}))};
  const standard = pad.mapping === 'standard';
  return {
    id: `browser:${pad.index}`, slot: pad.index, name: pad.id,
    mapping: pad.mapping, timestamp: pad.timestamp, raw,
    buttons: standard ? Object.fromEntries(BUTTONS.map((name, i) => [name, !!pad.buttons[i]?.pressed])) : {},
    sticks: standard ? {left: [pad.axes[0] || 0, pad.axes[1] || 0], right: [pad.axes[2] || 0, pad.axes[3] || 0]} : {left: [0,0], right: [0,0]},
    triggers: standard ? {lt: pad.buttons[6]?.value || 0, rt: pad.buttons[7]?.value || 0} : {lt: 0, rt: 0},
  };
}

export function selectDevice(devices, preferred) {
  // A missing explicitly selected device never silently transfers control to another.
  return preferred ? devices.find(device => device.id === preferred) || null : devices[0] || null;
}

export function freshWindowsState(state, receivedAt, now = performance.now()) {
  return !!state && Number.isFinite(state.ageMs) && Number.isFinite(state.updatedAt)
    && now - receivedAt < 700 && state.ageMs < 700;
}
