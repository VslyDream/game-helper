# Фрикамера — контракт адаптера

Фрикамера: `freecam:{enabled,speed,fov,sensitivity,moveSmoothing,lookSmoothing,focusDistance,aperture,focusLocked}`. `aperture:0` — вернуть игровую глубину резкости; остальные значения — f-числа. `freecam.set {key,value}`. Доступность оптики — `freecam.focusDistance`, `freecam.aperture`, `freecam.focusLocked`; общий ввод — `freecam.set`. При другой шкале размытия UI адаптируется, второй регулятор не добавляется. Адаптер хранит настройки; активная камера после перезапуска автоматически не включается.
