# Повторы — контракт адаптера

Повторы: `replays:{items:[],selectedId,status,kind,time,duration,speed,tracks:[],canSeek,observer}`; статусы `idle,loaded,recording,playing,paused,finished`. Дорожка `{id,name,enabled,actions}`. Команды с префиксом `replays.`: `record {kind}`, `load {id}`, `play`, `pause`, `restart`, `stop`, `seek {time}`, `speed {value}`, `observer {enabled}`, `track {id,enabled,actions}`, `overdub {id}`, `addTrack`, `rename {id,name}`, `trash {id}`, `restore {id}`. Пустые аргументы `{}`. Запись и подготовка мира выполняются в игре, а не таймером сайта. `canSeek` подтверждается адаптером.

Хоткеи записи и повтора (REPLAY-05) — обычные записи `state.hotkeys` с id `replays.record`, `replays.play`, `replays.stop`. Страница показывает их текущие клавиши и прячет строку подсказки, пока адаптер их не прислал.
