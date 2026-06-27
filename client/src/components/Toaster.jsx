import { useEffect, useState } from 'react';
import { subscribe } from '../lib/toast.js';

export default function Toaster() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    return subscribe(toast => {
      setToasts(ts => [...ts, toast]);
      setTimeout(() => {
        setToasts(ts => ts.filter(t => t.id !== toast.id));
      }, 3760);
    });
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}
