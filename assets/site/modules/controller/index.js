import {BUTTONS, LABELS, browserDevice, radialDeadzone, selectDevice, freshWindowsState} from './input.mjs';

const STORAGE_KEY = 'game-helper.controller.v1';
const defaults = {source: 'windows', deadzone: 0.10, devices: {}};
export function readPreferences() {
  let stored = {};
  try {stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};} catch {}
  const zone = Number(stored.deadzone ?? defaults.deadzone);
  return {source: stored.source === 'browser' ? 'browser' : 'windows',
    deadzone: Number.isFinite(zone) ? Math.max(0, Math.min(0.5, zone)) : 0.10,
    devices: stored.devices && typeof stored.devices === 'object' ? stored.devices : {}};
}
export function savePreferences(values) {
  try {localStorage.setItem(STORAGE_KEY, JSON.stringify({...readPreferences(), ...values}));} catch {}
}

export function mount(root, context = {}) {
  root.innerHTML = `
    <div class="controller-toolbar">
      <label>Источник ввода<select data-source aria-label="Источник ввода"><option value="windows">Windows · XInput</option><option value="browser">Браузер · Gamepad API</option></select></label>
      <label class="device-field">Устройство<select data-device aria-label="Устройство"></select></label>
    </div>
    <div class="panel controller-hero"><div class="controller-layout"><div class="controller-surface" data-picture></div>
      <div class="controller-side">
        <div><div class="trigger-line"><span>Левый курок · LT</span><output data-trigger-value="lt">0%</output></div><div class="trigger-meter"><span data-trigger-bar="lt"></span></div></div>
        <div><div class="trigger-line"><span>Правый курок · RT</span><output data-trigger-value="rt">0%</output></div><div class="trigger-meter"><span data-trigger-bar="rt"></span></div></div>
        <div><div class="readout-title">Левый стик</div><div class="stick-values"><span>X <output data-axis="left-x">0.000</output></span><span>Y <output data-axis="left-y">0.000</output></span></div></div>
        <div><div class="readout-title">Правый стик</div><div class="stick-values"><span>X <output data-axis="right-x">0.000</output></span><span>Y <output data-axis="right-y">0.000</output></span></div></div>
      </div></div>
      <div class="controller-legend"><span>Мёртвая зона <output data-zone></output></span><span>Вверх: Y −1 · вниз: Y +1</span></div>
      <div class="controller-active" data-active>Нет нажатых кнопок</div>
    </div>
    <p class="controller-message" data-message role="status"></p>
    <details class="panel controller-details" data-diagnostics><summary>Диагностика и исходные значения</summary>
      <p class="hint">Индексы браузера и слоты Windows независимы. XInput не сообщает точную модель устройства. Курки показывают ход, а не физическую силу.</p>
      <pre data-raw></pre><h3>Наблюдения Windows за время работы сервиса</h3>
      <p class="hint">Отметки ниже подтверждают только полученные значения. Совпадение с физическими кнопками проверяется человеком.</p>
      <div class="controller-checks" data-checks></div><pre data-observed></pre>
      <button class="quiet controller-export" data-export>Скачать отчёт JSON</button>
    </details>
    <p class="controller-note">Стенд только читает ввод. Управление персонажем в игре он не отключает.</p>`;
  const $ = selector => root.querySelector(selector);
  const sourceSelect = $('[data-source]');
  const deviceSelect = $('[data-device]');
  const message = $('[data-message]');
  let preferences = readPreferences(), windowsState = null, receivedAt = -Infinity;
  let stopped = false, pollTimer, frame, listKey = '', lastDetails = 0, lastStatus = '';
  let currentDevice = null, browserDevices = [], browserError = '', networkError = '';
  let svg = null, abort = null;
  const buttonNodes = new Map(), stickNodes = new Map();
  const triggerNodes = Object.fromEntries(['lt', 'rt'].map(name => [name, {
    value: $(`[data-trigger-value="${name}"]`), bar: $(`[data-trigger-bar="${name}"]`),
  }]));
  const axisNodes = Object.fromEntries(['left', 'right'].map(name => [name, ['x','y'].map(axis => $(`[data-axis="${name}-${axis}"]`))]));
  sourceSelect.value = preferences.source;

  fetch(new URL('./controller.svg', import.meta.url)).then(response => {
    if (!response.ok) throw new Error('Не загрузилось изображение контроллера.');
    return response.text();
  }).then(markup => {
    if (stopped) return;
    const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
    svg = document.documentElement;
    if (svg.tagName !== 'svg') throw new Error('Ошибка изображения SVG.');
    $('[data-picture]').replaceChildren(svg);
    for (const node of svg.querySelectorAll('[data-button]')) buttonNodes.set(node.dataset.button, node);
    for (const node of svg.querySelectorAll('[data-stick]')) stickNodes.set(node.dataset.stick, node);
  }).catch(error => {if (!stopped) $('[data-picture]').textContent = error.message;});

  sourceSelect.addEventListener('change', () => {
    savePreferences({source: sourceSelect.value});
    preferences = readPreferences(); listKey = ''; currentDevice = null;
  });
  deviceSelect.addEventListener('change', () => {
    preferences = readPreferences();
    savePreferences({devices: {...preferences.devices, [preferences.source]: deviceSelect.value}});
    preferences = readPreferences();
  });

  async function poll() {
    if (stopped) return;
    const started = performance.now();
    abort = new AbortController();
    const timeout = setTimeout(() => abort?.abort(), 1000);
    try {
      const apiBase = (context.config?.apiBase || '/api').replace(/\/$/, '');
      const response = await fetch(context.controllerApi || apiBase + '/controller/state', {cache: 'no-store', signal: abort.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (value.source !== 'windows' || !Array.isArray(value.devices)) throw new Error('Неверный ответ API контроллера');
      windowsState = value; receivedAt = performance.now(); networkError = '';
    } catch (error) {
      windowsState = null;
      networkError = 'Windows-сервис недоступен: ' + (error.name === 'AbortError' ? 'нет ответа' : error.message);
    } finally {
      clearTimeout(timeout); abort = null;
      if (!stopped) pollTimer = setTimeout(poll, Math.max(0, 1000 / 30 - (performance.now() - started)));
    }
  }

  function updateDeviceList(devices) {
    const preferred = preferences.devices[preferences.source];
    if (!preferred && devices.length) {
      savePreferences({devices: {...preferences.devices, [preferences.source]: devices[0].id}});
      preferences = readPreferences();
    }
    const selected = preferences.devices[preferences.source];
    const key = JSON.stringify([preferences.source, selected, devices.map(device => [device.id, device.name])]);
    if (key === listKey) return;
    listKey = key;
    const options = devices.map(device => new Option(device.name, device.id));
    if (selected && !devices.some(device => device.id === selected)) options.unshift(new Option('Выбранное устройство отключено', selected));
    if (!options.length) options.push(new Option('Устройство не обнаружено', ''));
    deviceSelect.replaceChildren(...options);
    deviceSelect.value = selected || devices[0]?.id || '';
    deviceSelect.disabled = !devices.length;
  }

  function paint(device) {
    const buttons = device?.buttons || {};
    for (const [name, node] of buttonNodes) node.classList.toggle('pressed', !!buttons[name] || (['lt','rt'].includes(name) && device?.triggers[name] > 0.05));
    for (const name of ['left', 'right']) {
      const values = radialDeadzone(...(device?.sticks[name] || [0,0]), preferences.deadzone);
      stickNodes.get(name)?.setAttribute('transform', `translate(${values[0] * 19} ${values[1] * 19})`);
      values.forEach((value, i) => {axisNodes[name][i].value = Math.abs(value) < 0.0005 ? '0.000' : value.toFixed(3);});
    }
    for (const name of ['lt','rt']) {
      const percent = Math.max(0, Math.min(100, (device?.triggers[name] || 0) * 100));
      triggerNodes[name].value.value = `${percent.toFixed(1)}%`;
      triggerNodes[name].bar.style.width = `${percent}%`;
    }
    const pressed = Object.keys(buttons).filter(name => buttons[name]);
    $('[data-active]').textContent = pressed.length ? 'Нажаты: ' + pressed.map(name => LABELS[name] || name).join(' · ') : 'Нет нажатых кнопок';
    $('[data-zone]').value = preferences.deadzone.toFixed(2);
  }

  function details(device) {
    const selectedSlot = device?.slot ?? Number((preferences.devices.windows || '').split(':')[1]);
    const observed = preferences.source === 'windows' ? windowsState?.observed?.[selectedSlot] : null;
    $('[data-raw]').textContent = JSON.stringify({
      source: preferences.source, id: device?.id || null, mapping: device?.mapping ?? null,
      browserFocused: document.hasFocus(), browserVisible: document.visibilityState,
      windows: windowsState ? {status: windowsState.status, library: windowsState.library,
        samples: windowsState.samples, updatedAt: windowsState.updatedAt, ageMs: windowsState.ageMs,
        error: windowsState.error, slotErrors: windowsState.slotErrors} : {error: networkError},
      device: device || null,
    }, null, 2);
    $('[data-observed]').textContent = observed ? JSON.stringify(observed, null, 2) : 'Выберите Windows-источник и подключённый слот для накопленных наблюдений.';
    const checks = observed ? [
      ['Кнопки: ' + observed.buttonsSeen.length + '/14', observed.buttonsSeen.length === 14],
      ['Оба стика: полный ход', observed.axesMin.every(v => v < -0.9) && observed.axesMax.every(v => v > 0.9)],
      ['LT: промежуточные значения', observed.triggerIntermediate[0]],
      ['RT: промежуточные значения', observed.triggerIntermediate[1]],
      ['Курки одновременно', observed.bothTriggers],
      ['Переподключение', observed.connections > 1 && observed.disconnects > 0],
    ] : [];
    $('[data-checks]').replaceChildren(...checks.map(([label, seen]) => {
      const node = document.createElement('span'); node.textContent = `${seen ? '✓' : '○'} ${label}`;
      node.classList.toggle('seen', !!seen); return node;
    }));
  }

  function render(now) {
    if (stopped) return;
    frame = requestAnimationFrame(render);
    preferences = readPreferences();
    if (sourceSelect.value !== preferences.source) sourceSelect.value = preferences.source;
    browserError = '';
    try {
      if (!window.isSecureContext) throw new Error('Gamepad API требует защищённый контекст: откройте стенд через 127.0.0.1.');
      if (!navigator.getGamepads) throw new Error('В этом браузере нет Gamepad API.');
      browserDevices = Array.from(navigator.getGamepads()).filter(Boolean).filter(pad => pad.connected).map(browserDevice);
    } catch (error) {browserDevices = []; browserError = error.message;}
    const windowsFresh = freshWindowsState(windowsState, receivedAt, now);
    const devices = preferences.source === 'windows' ? windowsFresh ? windowsState.devices : [] : browserDevices;
    updateDeviceList(devices);
    let device = selectDevice(devices, preferences.devices[preferences.source]);
    let text = '', warning = false;
    if (preferences.source === 'windows') {
      if (networkError) {text = networkError; warning = true;}
      else if (!windowsState) text = 'Подключение к Windows-сервису…';
      else if (!windowsFresh) {text = 'Нет свежих данных от Windows. Показания сброшены.'; warning = true; device = null;}
      else if (windowsState.error || Object.keys(windowsState.slotErrors || {}).length) {
        text = windowsState.error || Object.values(windowsState.slotErrors).join('; '); warning = true;
      } else if (!device) {
        text = browserDevices.length ? 'Браузер видит контроллер, XInput — нет. Проверьте режим подключения устройства.' : 'XInput-контроллер не обнаружен. Подключите USB-кабель и включите контроллер.';
        if (devices.length) text = 'Выбранный контроллер отключён. Выберите другое устройство или подключите его снова.';
      } else text = `${device.name} · чтение Windows активно`;
    } else if (browserError) {text = browserError; warning = true;}
    else if (!document.hasFocus() || document.hidden) {text = 'Браузер без фокуса: показания приостановлены. Для независимого чтения выберите Windows.'; device = null;}
    else if (!device) text = 'Подключите контроллер и нажмите любую кнопку, пока эта вкладка активна.';
    else if (device.mapping !== 'standard') {text = 'Нестандартная раскладка: исходные значения доступны в диагностике; назначения не угадываются.'; warning = true;}
    else text = `${device.name} · стандартная раскладка`;
    if (context.isActive && !context.isActive()) device = null;
    currentDevice = device;
    paint(device);
    if (message.textContent !== text) message.textContent = text;
    message.classList.toggle('warning', warning);
    const status = warning ? 'Ошибка чтения контроллера' : device ? 'Контроллер подключён' : 'Ожидание контроллера';
    const statusKey = `${status}:${!!device}`;
    if (statusKey !== lastStatus) {context.onStatus?.(status, !!device); lastStatus = statusKey;}
    if (now - lastDetails > 150 && $('[data-diagnostics]').open) {details(device); lastDetails = now;}
  }

  $('[data-export]').addEventListener('click', () => {
    const report = {schema: 1, createdAt: new Date().toISOString(),
      hardwareClaim: 'Модель Flydigi Direwolf 4 и USB указаны пользователем; XInput не подтверждает модель.',
      manuallyVerified: false, preferences: readPreferences(), browser: {userAgent: navigator.userAgent, devices: browserDevices},
      windows: windowsState, selected: currentDevice};
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'controller-report.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function clearBrowserPicture() {if (readPreferences().source === 'browser') {currentDevice = null; paint(null);}}
  window.addEventListener('blur', clearBrowserPicture);
  document.addEventListener('visibilitychange', clearBrowserPicture);
  poll(); frame = requestAnimationFrame(render);
  return {dispose() {
    stopped = true; clearTimeout(pollTimer); cancelAnimationFrame(frame); abort?.abort();
    window.removeEventListener('blur', clearBrowserPicture);
    document.removeEventListener('visibilitychange', clearBrowserPicture);
    paint(null);
  }};
}

export function mountSettings(parent, context = {}) {
  const panel = document.createElement('section');
  panel.className = 'panel controller-settings'; panel.id = 'controller'; panel.style.marginTop = '14px';
  panel.innerHTML = `<h2>🎮 Контроллер</h2><label class="control"><span>Радиальная мёртвая зона <output></output></span><input type="range" min="0" max="0.5" step="0.01" aria-label="Мёртвая зона контроллера"></label>`;
  const input = panel.querySelector('input'), output = panel.querySelector('output');
  input.value = readPreferences().deadzone; output.value = Number(input.value).toFixed(2);
  input.addEventListener('input', () => {savePreferences({deadzone:Number(input.value)}); output.value = Number(input.value).toFixed(2);});
  // The camera layout is not drawn here: it is a section of «Хоткеи» on the same page, built from the current
  // bindings (state.hotkeys[].section) and the profile's fixed sticks and triggers (config.hotkeySections).
  const details = document.createElement('details'); details.className = 'controller-settings-fold'; details.id = 'controller-check';
  const summary = document.createElement('summary'); summary.textContent = 'Проверить кнопки, стики и курки';
  const content = document.createElement('div'); content.className = 'controller-test-content';
  details.append(summary,content); panel.append(details);
  let instance = null;
  const toggle = () => {
    if (details.open && !instance) instance = mount(content,context);
    else if (!details.open && instance) {instance.dispose(); instance = null; content.replaceChildren();}
  };
  const openFromHash = () => {if (!parent.hidden && location.hash === '#controller-check') {details.open = true; toggle();}};
  details.addEventListener('toggle',toggle); addEventListener('hashchange',openFromHash);
  const paths = parent.querySelector('#settings-paths');
  if (paths) paths.before(panel); else parent.append(panel);
  openFromHash();
  return {dispose() {removeEventListener('hashchange',openFromHash); details.removeEventListener('toggle',toggle); instance?.dispose();}};
}
