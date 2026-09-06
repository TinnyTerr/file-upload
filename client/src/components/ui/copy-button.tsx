import { Check, Copy } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { copyToClipboard } from "@/lib/copy";
import { Button, type ButtonProps } from "./button";
import { Tooltip } from "./tooltip";

interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
	value: string;
	label?: string;
	tooltip?: string;
	children?: React.ReactNode;
}

/** Icon/label button that copies `value` and shows a transient "copied" state. */
export function CopyButton({
	value,
	label,
	tooltip = "Copy",
	children,
	variant = "ghost",
	size = label || children ? "sm" : "icon",
	className,
	...props
}: CopyButtonProps) {
	const [copied, setCopied] = React.useState(false);
	const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

	React.useEffect(() => () => clearTimeout(timer.current), []);

	const onCopy = async () => {
		const ok = await copyToClipboard(value);
		if (!ok) {
			// Plain-HTTP LAN installs don't get the Clipboard API at all -- the
			// visible "copied" checkmark never appearing would otherwise look
			// like the click did nothing.
			toast.error("Couldn't copy — select and copy manually");
			return;
		}
		setCopied(true);
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), 1400);
	};

	const content = label ?? children;
	const btn = (
		<Button
			variant={variant}
			size={size}
			onClick={onCopy}
			className={cn(className)}
			aria-label={
				props["aria-label"] ?? (typeof tooltip === "string" ? tooltip : "Copy")
			}
			{...props}
		>
			{copied ? <Check className="text-success" /> : <Copy />}
			{content}
		</Button>
	);

	return <Tooltip content={copied ? "Copied!" : tooltip}>{btn}</Tooltip>;
}
