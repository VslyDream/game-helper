"""Read-only XInput provider. No input injection, hooks, or game suppression."""
import copy
import ctypes
import math
import os
import threading
import time

BUTTON_MASKS = {
    'a': 0x1000, 'b': 0x2000, 'x': 0x4000, 'y': 0x8000,
    'lb': 0x0100, 'rb': 0x0200, 'back': 0x0020, 'start': 0x0010,
    'ls': 0x0040, 'rs': 0x0080, 'up': 0x0001, 'down': 0x0002,
    'left': 0x0004, 'right': 0x0008,
}


class Gamepad(ctypes.Structure):
    _fields_ = [('buttons', ctypes.c_uint16), ('lt', ctypes.c_uint8),
                ('rt', ctypes.c_uint8), ('lx', ctypes.c_int16),
                ('ly', ctypes.c_int16), ('rx', ctypes.c_int16), ('ry', ctypes.c_int16)]


class State(ctypes.Structure):
    _fields_ = [('packet', ctypes.c_uint32), ('gamepad', Gamepad)]


def axis(value):
    return value / (32768 if value < 0 else 32767)


def radial_deadzone(x, y, zone=0.10):
    """Preserve direction; rescale the usable radius to 0..1."""
    zone = max(0, min(0.95, float(zone)))
    length = math.hypot(x, y)
    if length <= zone:
        return [0.0, 0.0]
    scale = min(1.0, (length - zone) / (1.0 - zone)) / length
    return [x * scale, y * scale]


def normalize(state, slot, sampled_at=None):
    pad = state.gamepad
    return {
        'id': f'xinput:{slot}', 'slot': slot, 'name': f'XInput · слот {slot + 1}',
        'mapping': 'standard', 'packet': state.packet,
        'sampledAt': sampled_at if sampled_at is not None else time.time() * 1000,
        'raw': {key: getattr(pad, key) for key in ('buttons', 'lt', 'rt', 'lx', 'ly', 'rx', 'ry')},
        'buttons': {name: bool(pad.buttons & mask) for name, mask in BUTTON_MASKS.items()},
        'sticks': {'left': [axis(pad.lx), -axis(pad.ly)],
                   'right': [axis(pad.rx), -axis(pad.ry)]},
        'triggers': {'lt': pad.lt / 255, 'rt': pad.rt / 255},
    }


class XInputReader:
    def __init__(self):
        self.library = None
        errors = []
        if os.name != 'nt':
            raise OSError('XInput доступен только в Windows.')
        for name in ('xinput1_4.dll', 'xinput9_1_0.dll'):
            try:
                self.library = ctypes.WinDLL(name)
                self.name = name
                self.read = self.library.XInputGetState
                self.read.argtypes = [ctypes.c_uint32, ctypes.POINTER(State)]
                self.read.restype = ctypes.c_uint32
                break
            except (OSError, AttributeError) as error:
                errors.append(str(error))
        if self.library is None:
            raise OSError('Не удалось загрузить XInput: ' + '; '.join(errors))

    def __call__(self, slot):
        value = State()
        result = self.read(slot, ctypes.byref(value))
        if result == 1167:  # ERROR_DEVICE_NOT_CONNECTED
            return None
        if result:
            raise OSError(f'XInputGetState: 0x{result:08X}')
        return value


class ControllerService:
    def __init__(self, reader=None):
        self.reader = reader
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.devices = {}
        self.observed = {}
        self.errors = {}
        self.error = None
        self.library = None
        self.samples = 0
        self.updated = time.time() * 1000
        self.started = self.updated
        self.next_probe = [0.0] * 4

    def start(self):
        self.thread = threading.Thread(target=self._run, name='controller-input', daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)

    def tick(self, now=None):
        now = time.monotonic() if now is None else now
        sampled_at = time.time() * 1000
        with self.lock:
            for slot in range(4):
                if slot not in self.devices and now < self.next_probe[slot]:
                    continue
                try:
                    state = self.reader(slot)
                    self.errors.pop(slot, None)
                except Exception as error:
                    self.errors[slot] = str(error)
                    state = None
                if state is None:
                    if slot in self.devices:
                        self.observed[slot]['disconnects'] += 1
                    self.devices.pop(slot, None)
                    self.next_probe[slot] = now + 1
                    continue
                device = normalize(state, slot, sampled_at)
                stats = self.observed.setdefault(slot, {
                    'buttonsSeen': [], 'axesMin': [1.0] * 4, 'axesMax': [-1.0] * 4,
                    'triggerMin': [1.0, 1.0], 'triggerMax': [0.0, 0.0],
                    'triggerIntermediate': [False, False], 'bothTriggers': False,
                    'connections': 0, 'disconnects': 0, 'samples': 0,
                })
                if slot not in self.devices:
                    stats['connections'] += 1
                stats['samples'] += 1
                stats['buttonsSeen'] = sorted(set(stats['buttonsSeen']) | {
                    name for name, pressed in device['buttons'].items() if pressed})
                for i, value in enumerate(device['sticks']['left'] + device['sticks']['right']):
                    stats['axesMin'][i] = min(stats['axesMin'][i], value)
                    stats['axesMax'][i] = max(stats['axesMax'][i], value)
                for i, value in enumerate(device['triggers'].values()):
                    stats['triggerMin'][i] = min(stats['triggerMin'][i], value)
                    stats['triggerMax'][i] = max(stats['triggerMax'][i], value)
                    stats['triggerIntermediate'][i] |= 0.05 < value < 0.95
                stats['bothTriggers'] |= all(v > 0.5 for v in device['triggers'].values())
                self.devices[slot] = device
            self.samples += 1
            self.updated = sampled_at

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({
                'source': 'windows', 'status': 'error' if self.error or self.errors else 'ready',
                'error': self.error, 'slotErrors': self.errors, 'library': self.library,
                'startedAt': self.started, 'updatedAt': self.updated,
                'ageMs': max(0, time.time() * 1000 - self.updated),
                'samples': self.samples, 'devices': list(self.devices.values()),
                'observed': self.observed,
            })

    def _run(self):
        initialized = False
        try:
            # Recent XInput implementations can require COM on the calling thread.
            if os.name == 'nt':
                result = ctypes.windll.ole32.CoInitializeEx(None, 0)
                initialized = result in (0, 1)
            if self.reader is None:
                self.reader = XInputReader()
                self.library = self.reader.name
            while not self.stop_event.is_set():
                started = time.monotonic()
                self.tick(started)
                # Event.wait uses coarse Windows timer ticks (~15.6 ms here).
                # Python 3.11+ sleep uses a high-resolution waitable timer instead.
                time.sleep(max(0, 1 / 120 - (time.monotonic() - started)))
        except Exception as error:
            with self.lock:
                self.error = str(error)
                self.devices.clear()
        finally:
            if initialized:
                ctypes.windll.ole32.CoUninitialize()
