import {h, heading, toggle, commandButton} from '../../core/ui.js';
import {renderCategory} from '../cheats/index.js';

// Staging (STAGE-01): its own page. Freeze the world while arranging, release with one action.
// Project sections (squads, waves, spawners) come from config.staging.sections in the cheats format.
export function mount(parent, context) {
  const hotkey = context.config.staging?.actionHotkey || '';
  const prepare = toggle({label:'Подготовка', command:'staging.prepare', read:state => state.staging?.prepare, context});
  prepare.classList.add('staging-prepare');
  const action = commandButton('▶ Мотор', 'staging.action', context, () => ({}), 'primary');
  action.append(h('kbd', {'data-hotkey':'staging.action', hidden:!hotkey}, hotkey));
  const pins = context.pins;
  pins?.register({key:'staging:prepare', label:'Подготовка', kind:'toggle', capability:'staging.prepare',
    read:state => state.staging?.prepare, set:value => context.bridge.call('staging.prepare', {enabled:value})});
  pins?.register({key:'staging:action', label:'▶ Мотор', kind:'action', hotkey:'staging.action', hint:hotkey, capability:'staging.action',
    run:() => context.bridge.call('staging.action', {}), primary:true});
  prepare.querySelector('span').append(pins?.button('staging:prepare') || '');
  parent.append(heading('Постановка', prepare, h('span', {class:'inline pin-host'}, action, pins?.button('staging:action'))));
  const grid = h('div', {class:'cheat-grid'});
  for (const category of context.config.staging?.sections || []) {
    if (category.controls?.length) grid.append(renderCategory(category, context, 'staging-'));
  }
  if (grid.childElementCount) parent.append(grid);
  return grid;
}
