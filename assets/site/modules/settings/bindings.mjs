const aliases = {space:'Пробел',spacebar:'Пробел','пробел':'Пробел',escape:'Esc',esc:'Esc',arrowup:'Up',arrowdown:'Down',arrowleft:'Left',arrowright:'Right',enter:'Enter',return:'Enter',tab:'Tab',backspace:'Backspace',delete:'Delete',del:'Delete',insert:'Insert',ins:'Insert',home:'Home',end:'End',pageup:'PageUp',pagedown:'PageDown',capslock:'CapsLock',add:'NumAdd',subtract:'NumSubtract',multiply:'NumMultiply',divide:'NumDivide',decimal:'NumDecimal'};
const punctuation = {',':'Comma','.':'Period','/':'Slash',';':'Semicolon',"'":'Quote','[':'BracketLeft',']':'BracketRight','\\':'Backslash','-':'Minus','=':'Equal','`':'Backquote'};
const named = ['Comma','Period','Slash','Semicolon','Quote','BracketLeft','BracketRight','Backslash','Minus','Equal','Backquote','NumAdd','NumSubtract','NumMultiply','NumDivide','NumDecimal'];
export const PAD_BUTTONS = ['View','Menu','A','B','X','Y','LB','RB','LT','RT','L3','R3','↑','↓','←','→'];
export function normalizeKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (aliases[key.toLowerCase()]) return aliases[key.toLowerCase()];
  if (punctuation[key]) return punctuation[key];
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (/^(num|numpad)[0-9]$/i.test(key)) return 'Num' + key.slice(-1);
  const found = named.find(item => item.toLowerCase() === key.toLowerCase());
  if (found) return found;
  throw new Error('Укажите одну клавишу: латинскую букву, цифру, F1–F24, Num9, Enter и т. п.');
}
export function keyboardBinding(key, modifiers = {}) {
  const normalized = normalizeKey(key);
  return normalized ? [modifiers.ctrl && 'Ctrl',modifiers.alt && 'Alt',modifiers.shift && 'Shift',normalized].filter(Boolean).join('+') : '';
}
export function parseKeyboard(value) {
  const parts = String(value || '').split('+').map(part => part.trim()).filter(Boolean);
  const modifiers = {ctrl:false,alt:false,shift:false}, keys = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (['ctrl','control'].includes(lower)) modifiers.ctrl = true;
    else if (lower === 'alt') modifiers.alt = true;
    else if (lower === 'shift') modifiers.shift = true;
    else keys.push(part);
  }
  if (keys.length > 1) throw new Error('В комбинации может быть одна основная клавиша.');
  if (parts.length && !keys.length) throw new Error('Укажите клавишу вместе с модификаторами.');
  const key = normalizeKey(keys[0] || '');
  return {key,...modifiers,keys:keyboardBinding(key,modifiers)};
}
export function gamepadBinding(value) {
  const parts = Array.isArray(value) ? value : String(value || '').split('+').map(part => part.trim()).filter(Boolean);
  const selected = new Set(parts.map(part => {
    const map = {back:'View',start:'Menu',ls:'L3',rs:'R3',up:'↑',down:'↓',left:'←',right:'→'};
    const name = map[String(part).toLowerCase()] || PAD_BUTTONS.find(button => button.toLowerCase() === String(part).toLowerCase());
    if (!name) throw new Error('Неизвестная кнопка контроллера: ' + part);
    return name;
  }));
  return PAD_BUTTONS.filter(button => selected.has(button)).join('+');
}
// Reading a combination from a real controller for the binding dialog. A trigger counts as pressed from the same
// threshold as in the game adapter.
export const PAD_TRIGGER_PRESS = 0.5;
const WINDOWS_BUTTONS = {a:'A',b:'B',x:'X',y:'Y',lb:'LB',rb:'RB',back:'View',start:'Menu',ls:'L3',rs:'R3',up:'↑',down:'↓',left:'←',right:'→'};
const BROWSER_BUTTONS = ['A','B','X','Y','LB','RB','LT','RT','View','Menu','L3','R3','↑','↓','←','→']; // Gamepad API, mapping «standard»
/** Pressed buttons of one device from GET /api/controller/state (Windows · XInput). */
export function padPressedWindows(device) {
  const pressed = Object.entries(device?.buttons || {}).filter(([name, down]) => down && WINDOWS_BUTTONS[name]).map(([name]) => WINDOWS_BUTTONS[name]);
  if (device?.triggers?.lt >= PAD_TRIGGER_PRESS) pressed.push('LT');
  if (device?.triggers?.rt >= PAD_TRIGGER_PRESS) pressed.push('RT');
  return pressed;
}
/** Pressed buttons of one browser Gamepad; a non-standard layout is not guessed. */
export function padPressedBrowser(pad) {
  if (!pad || pad.mapping !== 'standard') return [];
  return BROWSER_BUTTONS.filter((name, index) => {
    const button = pad.buttons?.[index];
    return ['LT','RT'].includes(name) ? button?.value >= PAD_TRIGGER_PRESS : !!button?.pressed;
  });
}
/**
 * One press of a combination: everything pressed from the first button down until all are released.
 * step(pressed) → null while nothing happens, {keys, done:false} while buttons are held, {keys, done:true} on release.
 */
export function createPadCapture() {
  let held = null;
  return {step(pressed) {
    if (pressed.length) {
      held ||= new Set();
      for (const name of pressed) held.add(name);
      return {keys:gamepadBinding([...held]),done:false};
    }
    if (!held) return null;
    const keys = gamepadBinding([...held]); held = null;
    return {keys,done:true};
  }};
}
export function comboFromEvent(event) {
  if (['Control','Shift','Alt','Meta'].includes(event.key)) return '';
  const key = (event.code || event.key).replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'Num');
  return keyboardBinding(key,{ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey});
}
export function bindingConflict(items, id, device, keys) {
  const normalize = device === 'gamepad' ? gamepadBinding : value => parseKeyboard(value).keys;
  const canonical = normalize(keys);
  if (!canonical) return '';
  const field = device === 'gamepad' ? 'gamepadKeys' : 'keys';
  const duplicate = items.find(item => {
    if (item.id === id || !item[field]) return false;
    try {return normalize(item[field]) === canonical;} catch {return false;}
  });
  return duplicate ? 'Совпадает с «' + duplicate.label + '».' : '';
}
