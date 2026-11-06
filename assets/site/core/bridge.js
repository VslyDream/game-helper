export async function createBridge(config) {
  if (config.demo) {
    const {createDemoBridge} = await import('./demo.js');
    return createDemoBridge(config);
  }
  let state = {connection:'offline', availability:{}};
  let pending = 0, serial = Promise.resolve(), timer, epoch = 0, closed = false;
  const listeners = new Set();
  const emit = () => {for (const listener of listeners) listener(state)};
  const request = async (path, options = {}) => {
    const response = await fetch((config.apiBase || '/api') + path, {...options, signal:AbortSignal.timeout(15000), cache:'no-store'});
    if (!response.ok) throw new Error('Локальный сервис вернул ошибку ' + response.status);
    return response.json();
  };
  const bridge = {
    get state() {return state},
    get busy() {return pending > 0 || !!state.operation},
    subscribe(fn) {listeners.add(fn); fn(state); return () => listeners.delete(fn)},
    available(command) {
      const item = state.availability?.[command];
      return {enabled:!!item?.enabled && !bridge.busy, reason:bridge.busy ? 'Выполняется операция' : item?.reason || 'Пока недоступно'};
    },
    call(command, args = {}) {
      pending++; epoch++; emit();
      const id = crypto.randomUUID();
      const work = serial.then(async () => {
        const result = await request('/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id, command, args})});
        if (!result.ok) throw new Error(result.error || 'Игра не выполнила действие.');
        if (result.state) state = result.state;
        return result;
      }).finally(() => {pending--; emit()});
      serial = work.catch(() => {});
      return work;
    },
    async refresh() {
      const revision = epoch;
      if (closed) return;
      if (pending) {clearTimeout(timer); timer = setTimeout(() => bridge.refresh(), 1500); return}
      try {
        const value = await request('/state');
        if (revision === epoch) {state = value; emit()}
      } catch {
        if (revision === epoch) {state = {...state, connection:'offline', availability:{}, operation:null}; emit()}
      } finally {
        clearTimeout(timer);
        if (!closed) timer = setTimeout(() => bridge.refresh(), 1500);
      }
    },
    close() {closed = true; clearTimeout(timer); listeners.clear()}
  };
  return bridge;
}
