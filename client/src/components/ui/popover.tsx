import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * For flyouts holding arbitrary content — sort and view menus, the column
 * chooser, the upload options form.
 *
 * Deliberately not `DropdownMenu`: a menu's items own typeahead and the arrow
 * keys, so any input inside one loses characters and cursor movement to the
 * menu's own keyboard handling. A popover is just a positioned layer.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = React.forwardRef<
	React.ElementRef<typeof PopoverPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, ...props }, ref) => (
	<PopoverPrimitive.Portal>
		<PopoverPrimitive.Content
			ref={ref}
			align={align}
			sideOffset={sideOffset}
			className={cn(
				"z-50 w-72 rounded-md border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg shadow-black/20 backdrop-blur-xl outline-none",
				"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
				className,
			)}
			{...props}
		/>
	</PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
