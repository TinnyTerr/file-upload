import QRCodeLib from "qrcode";
import * as React from "react";
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
		if (value.length > 1200) return;
		let cancelled = false;
		const handle = window.requestAnimationFrame(() => {
			if (cancelled) return;
			QRCodeLib.toCanvas(canvas, value, {
				width: size,
				margin: 1,
				color: { dark: "#0a0a0f", light: "#ffffff" },
				errorCorrectionLevel: "M",
			}).catch(() => {
				/* ignore render errors (e.g. value too long) */
			});
		});
		return () => {
			cancelled = true;
			window.cancelAnimationFrame(handle);
			canvas.getContext("2d")?.clearRect(0, 0, size, size);
		};
	}, [value, size]);

	return (
		<div
			className={cn("inline-flex rounded-lg bg-white p-2 shadow-lg", className)}
		>
			<canvas ref={canvasRef} width={size} height={size} />
		</div>
	);
}
