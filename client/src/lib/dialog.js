// Imperative dialog singleton. DialogManager.jsx calls _register on mount.
let _showFn = null;

export function _register(fn) {
  _showFn = fn;
}

export function showAlert({ title = "Heads up", message = "", glyph = "!", kind = "" } = {}) {
  return new Promise(resolve => {
    if (!_showFn) { resolve(undefined); return; }
    _showFn({ type: 'alert', title, message, glyph, kind, resolve });
  });
}

export function showConfirm({
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  glyph,
} = {}) {
  return new Promise(resolve => {
    if (!_showFn) { resolve(false); return; }
    _showFn({ type: 'confirm', title, message, confirmText, cancelText, danger, glyph, resolve });
  });
}

export function showPrompt({
  title = "Enter a value",
  message = "",
  placeholder = "",
  defaultValue = "",
  confirmText = "OK",
  cancelText = "Cancel",
  glyph = "✎",
} = {}) {
  return new Promise(resolve => {
    if (!_showFn) { resolve(null); return; }
    _showFn({ type: 'prompt', title, message, placeholder, defaultValue, confirmText, cancelText, glyph, resolve });
  });
}

export function showCopyModal(url, filename, { key = "", keyLabel = "", keyHint = "", hint = "" } = {}) {
  return new Promise(resolve => {
    if (!_showFn) { resolve(); return; }
    _showFn({ type: 'copy', url, filename, key, keyLabel, keyHint, hint, resolve });
  });
}
