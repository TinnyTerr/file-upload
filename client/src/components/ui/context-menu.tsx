import { type ReactNode, useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "./dropdown-menu";

/**
 * Right-click menu.
 *
 * Radix ships a dedicated context-menu primitive, but pulling in another
 * package for it would mean a second set of styles to keep in step with
 * `dropdown-menu.tsx`. Instead the dropdown is anchored to a zero-size element
 * parked at the cursor, which gives the same portalled, focus-trapped,
 * escape-to-close behaviour from the primitive already in the design system.
 */
export function ContextMenu({
	children,
	menu,
	disabled,
	className,
}: {
	children: ReactNode;
	/** Menu body — the same `DropdownMenuItem`s a button trigger would use. */
	menu: ReactNode;
	disabled?: boolean;
	className?: string;
}) {
	const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

	return (
		<>
			<div
				className={className}
				onContextMenu={(e) => {
					if (disabled) return;
					e.preventDefault();
					// Nested items would otherwise open every ancestor's menu too.
					e.stopPropagation();
					setPoint({ x: e.clientX, y: e.clientY });
				}}
			>
				{children}
			</div>
			<DropdownMenu
				open={point !== null}
				onOpenChange={(open) => {
					if (!open) setPoint(null);
				}}
			>
				<DropdownMenuTrigger asChild>
					<span
						aria-hidden
						className="pointer-events-none fixed"
						style={{ left: point?.x ?? 0, top: point?.y ?? 0 }}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" side="bottom" sideOffset={2}>
					{menu}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
