import {h, range, toggle, num, allowed, notify} from '../../core/ui.js';

export function mount(parent, context) {
  document.head.append(h('link', {rel:'stylesheet',href:'./modules/freecam/style.css'}));
  const read = key => state => state.freecam?.[key];
  const makeRange = options => range({...options, context, command:'freecam.set', read:read(options.key)});
  const controls = h('div', {class:'control-grid camera-controls'},
    makeRange({label:'Скорость',hint:'колесо',key:'speed',min:.04,max:200,step:.01,unit:'м/с',logarithmic:true}),
    makeRange({label:'Угол обзора',hint:'Alt + колесо',key:'fov',min:20,max:150,step:1,unit:'°'}),
    makeRange({label:'Чувствительность',key:'sensitivity',min:.01,max:.5,step:.01}),
    makeRange({label:'Плавность полёта',key:'moveSmoothing',min:0,max:1,step:.01,unit:'с'}),
    makeRange({label:'Плавность поворота',key:'lookSmoothing',min:0,max:1,step:.01,unit:'с'})
  );
  const panel = h('section', {class:'panel camera-panel',id:'camera'},
    h('div', {class:'panel-head'}, h('h2', {}, '🎥 Камера'),
      toggle({label:'',hint:'Ctrl+P / Num9',command:'freecam.set',key:'enabled',read:read('enabled'),context})),
    h('p', {class:'hint'}, 'WASD · Q / E — высота · Shift ×5 · без столкновений'), controls);
  panel.querySelector('input[type=checkbox]').setAttribute('aria-label','Свободная камера');
  const badge = panel.querySelector('.panel-head kbd');
  context.bridge.subscribe(state => {
    const binding = state.hotkeys?.find(item => item.id === 'freecam');
    if (binding && badge) badge.textContent = [binding.keys,binding.gamepadKeys?.replaceAll('+',' + ')].filter(Boolean).join(' · ') || 'Не назначено';
  });
  if (context.config.freecam?.optics !== false) {
    const optics = h('div', {class:'control-grid optics-grid'},
      makeRange({label:'Дистанция фокуса',hint:'Ctrl + колесо',key:'focusDistance',min:.1,max:50,step:.01,unit:'м',logarithmic:true,availability:'freecam.focusDistance'}));
    const stops = [0,16,11,8,5.6,4,2.8,2,1.4,1.2];
    const value = h('output', {});
    const aperture = h('input', {type:'range',min:0,max:9,step:1,'aria-label':'Диафрагма'});
    optics.append(h('div', {class:'control'}, h('span', {class:'control-label'},
      h('span', {}, 'Диафрагма', h('small', {}, 'Ctrl + Alt + колесо')), value), aperture));
    aperture.oninput = async () => {
      const number = stops[Number(aperture.value)]; value.textContent = number ? 'f/' + num(number) : 'выкл.';
    };
    aperture.onchange = async () => {
      try {await context.bridge.call('freecam.set', {key:'aperture',value:stops[Number(aperture.value)]})}
      catch (error) {notify(error.message)}
    };
    context.bridge.subscribe(state => {
      const number = state.freecam?.aperture || 0;
      if (document.activeElement !== aperture) aperture.value = Math.max(0,stops.indexOf(number));
      value.textContent = number ? 'f/' + num(number) : 'выкл.';
    });
    allowed(context.bridge, 'freecam.aperture', aperture);
    optics.append(toggle({label:'📍 Фокус на точке',hint:'СКМ',command:'freecam.set',key:'focusLocked',read:read('focusLocked'),context,availability:'freecam.focusLocked'}));
    if (context.config.freecam?.sensorWidthMm) {
      const focal = h('output', {});
      optics.append(h('div', {class:'lens-option',title:'Эквивалент для горизонтального сенсора ' + context.config.freecam.sensorWidthMm + ' мм'}, 'Объектив: ', focal));
      context.bridge.subscribe(state => {
        const fov = state.freecam?.fov;
        focal.textContent = fov ? '≈ ' + num(context.config.freecam.sensorWidthMm/2/Math.tan(fov*Math.PI/360)) + ' мм' : '—';
      });
    }
    const details = h('details', {class:'optics'}, h('summary', {}, '🔭 Оптика и глубина резкости'), optics);
    panel.append(details);
  }
  parent.prepend(panel);
}
