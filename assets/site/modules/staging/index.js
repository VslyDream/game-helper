import {h, toggle, commandButton} from '../../core/ui.js';

// Staging (STAGE-01): freeze the world while arranging, release with one action.
export function mount(parent, context) {
  const hotkey = context.config.staging?.actionHotkey || '';
  const panel = h('section', {class:'panel staging-panel', id:'staging'},
    h('div', {class:'panel-head'}, h('h2', {}, '🎬 Постановка'),
      h('div', {class:'inline'},
        toggle({label:'Подготовка', command:'staging.prepare', read:state => state.staging?.prepare, context}),
        commandButton('▶ Мотор' + (hotkey ? ' ' : ''), 'staging.action', context, () => ({}), 'primary'))));
  if (hotkey) panel.querySelector('button.primary').append(h('kbd', {}, hotkey));
  const camera = parent.querySelector('#camera');
  if (camera) camera.after(panel); else parent.prepend(panel);
}
