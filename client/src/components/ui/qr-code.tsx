import * as React from "react";
import QRCodeLib from "qrcode";
import { cn } from "@/lib/cn";

/** Render a value as a QR code into a canvas. */
export function QRCode({
  value,
  size = 180,
  className,
}: {
  value: string;
  size?: number;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    QRCodeLib.toCanvas(canvas, value, {
      width: size,
      margin: 1,
      color: { dark: "#0a0a0f", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch(() => {
      /* ignore render errors (e.g. value too long) */
    });
  }, [value, size]);

  return (
    <div className={cn("inline-flex rounded-lg bg-white p-2 shadow-lg", className)}>
      <canvas ref={canvasRef} width={size} height={size} />
    </div>
  );
}
