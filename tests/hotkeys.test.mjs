import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKeyboard,keyboardBinding,gamepadBinding,comboFromEvent,bindingConflict} from '../assets/site/modules/settings/bindings.mjs';
import {register} from '../assets/site/modules/settings/demo.js';

function fixture(modules = ['gamepad'], hotkeys) {
  const handlers = new Map(), state = {hotkeys};
  register({state,on:(command,handler) => handlers.set(command,handler)},{modules});
  return {state,run:(command,args) => handlers.get(command)(args),handlers};
}
test('manual input and pasted combinations use the same canonical keyboard binding', () => {
  assert.equal(keyboardBinding('p',{ctrl:true,shift:true}),'Ctrl+Shift+P');
  assert.equal(parseKeyboard('shift + CTRL + p').keys,'Ctrl+Shift+P');
  assert.equal(parseKeyboard('alt+num9').keys,'Alt+Num9');
  assert.equal(parseKeyboard('space').keys,'Пробел');
  assert.equal(parseKeyboard('').keys,'');
  assert.throws(() => parseKeyboard('Ctrl+Shift'));
  assert.throws(() => parseKeyboard('A+B'));
});
test('key capture handles physical keys, numpad, modifiers and arrows', () => {
  assert.equal(comboFromEvent({key:'з',code:'KeyP',ctrlKey:true,shiftKey:false,altKey:false}),'Ctrl+P');
  assert.equal(comboFromEvent({key:'Control',code:'ControlLeft'}),'');
  assert.equal(comboFromEvent({key:'9',code:'Numpad9'}),'Num9');
  assert.equal(comboFromEvent({key:'ArrowUp',code:'ArrowUp'}),'Up');
});
test('gamepad chords normalize aliases, order and duplicates', () => {
  assert.equal(gamepadBinding('y+back+Y'),'View+Y');
  assert.equal(gamepadBinding(['LB','start']),'Menu+LB');
  assert.equal(gamepadBinding('LS+RS'),'L3+R3');
  assert.throws(() => gamepadBinding('Guide'));
});
test('editing/resetting one device preserves the other binding', () => {
  const {state,run} = fixture();
  const freecam = () => state.hotkeys.find(item => item.id === 'freecam');
  run('hotkeys.set',{id:'freecam',keys:'Shift+Ctrl+G'});
  run('hotkeys.gamepad.set',{id:'freecam',keys:'a+view'});
  assert.equal(freecam().keys,'Ctrl+Shift+G');
  assert.equal(freecam().gamepadKeys,'View+A');
  run('hotkeys.reset',{id:'freecam'});
  assert.equal(freecam().keys,'Ctrl+P');
  assert.equal(freecam().gamepadKeys,'View+A');
  run('hotkeys.gamepad.reset',{id:'freecam'});
  assert.equal(freecam().gamepadKeys,'View+Y');
  assert.equal(freecam().keys,'Ctrl+P');
});
test('conflicts and reserved keys are rejected without changing the existing value', () => {
  const {state,run} = fixture();
  assert.throws(() => run('hotkeys.set',{id:'hideUi',keys:'ctrl+p'}),/Совпадает/);
  assert.equal(state.hotkeys.find(item => item.id === 'hideUi').keys,'H');
  assert.throws(() => run('hotkeys.set',{id:'hideUi',keys:'F5'}),/занята игрой/);
  assert.throws(() => run('hotkeys.gamepad.set',{id:'hideUi',keys:'Y+View'}),/Совпадает/);
  assert.equal(bindingConflict(state.hotkeys,'hideUi','gamepad','X'),'');
  run('hotkeys.set',{id:'freecam',keys:''});
  assert.equal(state.hotkeys[0].keys,'');
  assert.equal(state.hotkeys[0].gamepadKeys,'View+Y');
});
test('older stored keyboard settings survive adding controller bindings', () => {
  const stored = [{id:'freecam',label:'Камера',keys:'Ctrl+G',default:'Ctrl+P'}];
  const {state} = fixture(['gamepad'],stored);
  assert.equal(state.hotkeys[0].keys,'Ctrl+G');
  assert.equal(state.hotkeys[0].gamepadKeys,'View+Y');
  const withoutPad = fixture([]);
  assert.equal(withoutPad.handlers.has('hotkeys.gamepad.set'),false);
  assert.equal('gamepadKeys' in withoutPad.state.hotkeys[0],false);
});
