import test from 'node:test';
import assert from 'node:assert/strict';
import {parseKeyboard,keyboardBinding,gamepadBinding,comboFromEvent,bindingConflict,padPressedWindows,padPressedBrowser,createPadCapture} from '../assets/site/modules/settings/bindings.mjs';
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
test('a combination pressed on the controller is collected until every button is released', () => {
  const capture = createPadCapture();
  assert.equal(capture.step([]),null);
  assert.deepEqual(capture.step(['Y']),{keys:'Y',done:false});
  assert.deepEqual(capture.step(['Y','View']),{keys:'View+Y',done:false});
  assert.deepEqual(capture.step(['View']),{keys:'View+Y',done:false});
  assert.deepEqual(capture.step([]),{keys:'View+Y',done:true});
  assert.equal(capture.step([]),null);
  assert.deepEqual(padPressedWindows({buttons:{a:true,back:true,x:false},triggers:{lt:.2,rt:.9}}),['A','View','RT']);
  assert.deepEqual(padPressedBrowser({mapping:'standard',buttons:[{pressed:true},{},{},{},{},{},{value:.7},{value:.1}]}),['A','LT']);
  assert.deepEqual(padPressedBrowser({mapping:'',buttons:[{pressed:true}]}),[]);
});
test('a section of the list holds gamepad-only actions and does not disturb ordinary hotkeys', () => {
  const config = {modules:['gamepad']}, handlers = new Map(), state = {};
  register({state,on:(command,handler) => handlers.set(command,handler)},config);
  const camera = state.hotkeys.filter(item => item.section);
  assert.ok(camera.length && camera.every(item => item.gamepadOnly && !item.keys && item.gamepadKeys));
  assert.ok(camera.every(item => config.hotkeySections[item.section].keyboard[item.id]));
  assert.throws(() => handlers.get('hotkeys.gamepad.set')({id:'hideUi',keys:camera[0].gamepadKeys}),/Совпадает/);
  assert.equal(state.hotkeys.filter(item => !item.section).length,3);
});
test('the camera section is the main layout of GAMEPAD.md; focus and aperture need the optics', () => {
  const layout = optics => {
    const config = {modules:['gamepad'],freecam:{optics}}, state = {};
    register({state,on() {}},config);
    return Object.fromEntries(state.hotkeys.filter(item => item.section).map(item => [item.id.replace('freecam.pad.',''),item.gamepadKeys]));
  };
  assert.deepEqual(layout(true),{focusLock:'A',lookBoost:'R3',boost:'L3',zoom:'LB',focus:'RB',faster:'↑',slower:'↓',wider:'→',narrower:'←'});
  assert.deepEqual(layout(false),{lookBoost:'R3',boost:'L3',zoom:'LB',faster:'↑',slower:'↓'});
});
