import {h} from './ui.js';
export function mountNavigation(pages, active) {
  const main = document.getElementById('pages'), utility = document.getElementById('settings-nav');
  const categories = document.getElementById('categories');
  for (const item of pages) {
    const link = h('a',{href:'?page=' + item.id,class:item.id === active ? 'active' : '',
      'aria-current':item.id === active ? 'page' : null},item.title);
    if (item.id === 'settings') utility.append(link);
    else {
      const group = h('div',{class:'nav-page-group'},link);
      if (item.id === 'cheats') group.append(categories);
      main.append(group);
    }
  }
  categories.hidden = active !== 'cheats';
}
