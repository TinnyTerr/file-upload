import { useEffect, useRef } from "react";
import QR from "qrcode";

export function QRCode({ value, size = 132 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    QR.toCanvas(ref.current, value, {
      width: size,
      margin: 1,
      color: { dark: "#e9edf7", light: "#0e111b" },
      errorCorrectionLevel: "M",
    }).catch(() => {});
  }, [value, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      className="rounded-[var(--radius-field)] border border-[var(--color-line)]"
    />
  );
}
