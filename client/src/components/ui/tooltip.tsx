import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "@/lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
	<TooltipPrimitive.Portal>
		<TooltipPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			className={cn(
				"z-50 max-w-xs overflow-hidden rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg shadow-black/20 backdrop-blur-xl",
				"data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
				className,
			)}
			{...props}
		/>
	</TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/** Convenience wrapper: wrap any element with a hover tooltip. */
export function Tooltip({
	content,
	children,
	side = "top",
	delayDuration = 200,
	asChild = true,
}: {
	content: React.ReactNode;
	children: React.ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	delayDuration?: number;
	asChild?: boolean;
}) {
	if (!content) return <>{children}</>;
	return (
		<TooltipRoot delayDuration={delayDuration}>
			<TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
			<TooltipContent side={side}>{content}</TooltipContent>
		</TooltipRoot>
	);
}
