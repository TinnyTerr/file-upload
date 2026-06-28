let _listeners = [];

export function showToast(msg, type = 'success') {
  const id = Math.random().toString(36).slice(2);
  _listeners.forEach(fn => fn({ id, msg, type }));
}

export function subscribe(fn) {
  _listeners.push(fn);
  return () => {
    _listeners = _listeners.filter(f => f !== fn);
  };
}
