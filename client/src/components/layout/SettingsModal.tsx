import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	Camera,
	Eye,
	EyeOff,
	KeyRound,
	Laptop,
	LogOut,
	Monitor,
	Moon,
	Pencil,
	Settings,
	ShieldCheck,
	SlidersHorizontal,
	Sun,
	Trash2,
	TriangleAlert,
	Upload,
	User as UserIcon,
	X,
} from "lucide-react";
import * as React from "react";
import { useCallback, useRef, useState } from "react";
import type { Area } from "react-easy-crop";
import Cropper from "react-easy-crop";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/ui/user-avatar";
import { api, errorMessage } from "@/config/api";
import { SecurityTab } from "@/features/account/components/SecurityTab";
import { accountService } from "@/features/account/services/accountService";
import { ME_QUERY_KEY, useAuth } from "@/features/auth/hooks/auth";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export function ErrorMsg({ message }: { message: string }) {
	return (
		<p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
			<AlertCircle className="size-4 shrink-0" />
			{message}
		</p>
	);
}

export function PasswordInput({
	className,
	...props
}: React.ComponentProps<"input">) {
	const [show, setShow] = useState(false);
	return (
		<div className="relative">
			<Input
				{...props}
				type={show ? "text" : "password"}
				className={cn("pr-10", className)}
			/>
			<button
				type="button"
				tabIndex={-1}
				onClick={() => setShow((s) => !s)}
				className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
				aria-label={show ? "Hide password" : "Show password"}
			>
				{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
			</button>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Generic sub-modal shell (z-70 so it layers above the z-50 settings modal)
// ---------------------------------------------------------------------------

export function SubModal({
	open,
	onOpenChange,
	title,
	children,
	wide,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	title: string;
	children: React.ReactNode;
	wide?: boolean;
}) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content
					className={cn(
						"fixed left-1/2 top-1/2 z-[70] -translate-x-1/2 -translate-y-1/2",
						wide ? "w-full max-w-xl" : "w-full max-w-md",
						"rounded-xl border border-border bg-popover/95 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl",
						"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200",
					)}
				>
					<div className="mb-5 flex items-center justify-between">
						<h3 className="text-base font-semibold text-foreground">{title}</h3>
						<DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
							<X className="size-4" />
							<span className="sr-only">Close</span>
						</DialogPrimitive.Close>
					</div>
					{children}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

// ---------------------------------------------------------------------------
// Credential row (info row with edit button)
// ---------------------------------------------------------------------------

function CredRow({
	icon: Icon,
	label,
	value,
	masked,
	onEdit,
}: {
	icon: React.ElementType;
	label: string;
	value: string;
	masked?: boolean;
	onEdit: () => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-card/40 px-4 py-3 transition-colors hover:bg-card/60">
			<div className="flex items-center gap-3 min-w-0">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent">
					<Icon className="size-4 text-muted-foreground" />
				</div>
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">{label}</p>
					<p className="truncate text-sm font-medium text-foreground">
						{masked ? "••••••••••••" : value}
					</p>
				</div>
			</div>
			<Tooltip content={`Edit ${label.toLowerCase()}`} side="left">
				<Button
					variant="ghost"
					size="icon"
					className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
					onClick={onEdit}
					aria-label={`Edit ${label}`}
				>
					<Pencil className="size-3.5" />
				</Button>
			</Tooltip>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Change Username sub-modal
// ---------------------------------------------------------------------------

function ChangeUsernameModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const { user, refresh } = useAuth();
	const [username, setUsername] = useState(user?.username ?? "");
	const [currentPassword, setCurrentPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	React.useEffect(() => {
		if (open) {
			setUsername(user?.username ?? "");
			setCurrentPassword("");
			setError(null);
		}
	}, [open, user?.username]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (!username.trim()) {
			setError("Username cannot be empty.");
			return;
		}
		setSubmitting(true);
		try {
			await accountService.changeCredentials({
				current_password: currentPassword,
				new_username: username.trim(),
				new_password: currentPassword,
			});
			await refresh();
			toast.success("Username updated");
			onOpenChange(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SubModal open={open} onOpenChange={onOpenChange} title="Change Username">
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="cun-new">New username</Label>
					<Input
						id="cun-new"
						autoComplete="username"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="cun-pw">Current password (to confirm)</Label>
					<PasswordInput
						id="cun-pw"
						autoComplete="current-password"
						value={currentPassword}
						onChange={(e) => setCurrentPassword(e.target.value)}
						required
					/>
				</div>
				{error && <ErrorMsg message={error} />}
				<div className="flex justify-end gap-2 pt-1">
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button type="submit" loading={submitting}>
						Save
					</Button>
				</div>
			</form>
		</SubModal>
	);
}

// ---------------------------------------------------------------------------
// Change Password sub-modal
// ---------------------------------------------------------------------------

const MIN_PW = 12;

function ChangePasswordModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const { user, refresh } = useAuth();
	const [cur, setCur] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	React.useEffect(() => {
		if (open) {
			setCur("");
			setNext("");
			setConfirm("");
			setError(null);
		}
	}, [open]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		if (next.length < MIN_PW) {
			setError(`Minimum ${MIN_PW} characters.`);
			return;
		}
		if (next !== confirm) {
			setError("Passwords do not match.");
			return;
		}
		setSubmitting(true);
		try {
			await accountService.changeCredentials({
				current_password: cur,
				new_username: user?.username ?? "",
				new_password: next,
			});
			await refresh();
			toast.success("Password updated", {
				description: "Other sessions were signed out.",
			});
			onOpenChange(false);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SubModal open={open} onOpenChange={onOpenChange} title="Change Password">
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="cpw-cur">Current password</Label>
					<PasswordInput
						id="cpw-cur"
						autoComplete="current-password"
						value={cur}
						onChange={(e) => setCur(e.target.value)}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="cpw-new">New password</Label>
					<PasswordInput
						id="cpw-new"
						autoComplete="new-password"
						value={next}
						onChange={(e) => setNext(e.target.value)}
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="cpw-con">Confirm new password</Label>
					<PasswordInput
						id="cpw-con"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						required
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					Minimum {MIN_PW} characters.
				</p>
				{error && <ErrorMsg message={error} />}
				<div className="flex justify-end gap-2 pt-1">
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button type="submit" loading={submitting}>
						Save
					</Button>
				</div>
			</form>
		</SubModal>
	);
}

// ---------------------------------------------------------------------------
// Avatar crop helper — extract pixels from canvas
// ---------------------------------------------------------------------------

async function getCroppedBlob(
	imageSrc: string,
	pixelCrop: Area,
): Promise<Blob> {
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = imageSrc;
	});

	const canvas = document.createElement("canvas");
	const SIZE = 256;
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext("2d")!;

	// Draw circular clip
	ctx.beginPath();
	ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
	ctx.clip();

	ctx.drawImage(
		image,
		pixelCrop.x,
		pixelCrop.y,
		pixelCrop.width,
		pixelCrop.height,
		0,
		0,
		SIZE,
		SIZE,
	);

	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error("canvas toBlob failed"));
			},
			"image/jpeg",
			0.92,
		);
	});
}

// ---------------------------------------------------------------------------
// Crop modal
// ---------------------------------------------------------------------------

function CropModal({
	open,
	onOpenChange,
	imageSrc,
	onCropped,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	imageSrc: string;
	onCropped: (blob: Blob) => void;
}) {
	const [crop, setCrop] = useState({ x: 0, y: 0 });
	const [zoom, setZoom] = useState(1);
	const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
	const [processing, setProcessing] = useState(false);

	const onCropComplete = useCallback((_: Area, pixels: Area) => {
		setCroppedAreaPixels(pixels);
	}, []);

	const handleApply = async () => {
		if (!croppedAreaPixels) return;
		setProcessing(true);
		try {
			const blob = await getCroppedBlob(imageSrc, croppedAreaPixels);
			onCropped(blob);
			onOpenChange(false);
		} finally {
			setProcessing(false);
		}
	};

	return (
		<SubModal
			open={open}
			onOpenChange={onOpenChange}
			title="Crop profile photo"
			wide
		>
			<div className="relative h-72 w-full overflow-hidden rounded-lg bg-black/50">
				<Cropper
					image={imageSrc}
					crop={crop}
					zoom={zoom}
					aspect={1}
					cropShape="round"
					showGrid={false}
					onCropChange={setCrop}
					onZoomChange={setZoom}
					onCropComplete={onCropComplete}
					style={{
						containerStyle: { borderRadius: "0.5rem" },
						cropAreaStyle: { border: "2px solid oklch(0.64 0.08 155)" },
					}}
				/>
			</div>

			{/* Zoom slider */}
			<div className="mt-4 flex items-center gap-3">
				<span className="text-xs text-muted-foreground w-8 shrink-0">Zoom</span>
				<input
					type="range"
					min={1}
					max={3}
					step={0.01}
					value={zoom}
					onChange={(e) => setZoom(Number(e.target.value))}
					className="w-full accent-primary"
				/>
			</div>

			<div className="mt-4 flex justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={() => onOpenChange(false)}
				>
					Cancel
				</Button>
				<Button type="button" onClick={handleApply} loading={processing}>
					Apply crop
				</Button>
			</div>
		</SubModal>
	);
}

// ---------------------------------------------------------------------------
// Profile tab
// ---------------------------------------------------------------------------

function ProfileTab() {
	const { user, refresh } = useAuth();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [rawSrc, setRawSrc] = useState<string | null>(null);
	const [cropOpen, setCropOpen] = useState(false);
	const [preview, setPreview] = useState<string | null>(null);
	const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
	const [uploading, setUploading] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [avatarVersion, setAvatarVersion] = useState(Date.now());

	const ALLOWED_TYPES = new Set([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
	]);
	const MAX_RAW = 10 * 1024 * 1024; // 10 MiB raw before crop

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		setError(null);
		const file = e.target.files?.[0];
		if (!file) return;
		if (!ALLOWED_TYPES.has(file.type)) {
			setError("Only JPEG, PNG, GIF, or WebP images allowed.");
			return;
		}
		if (file.size > MAX_RAW) {
			setError("Image must be under 10 MB.");
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			setRawSrc(reader.result as string);
			setCropOpen(true);
		};
		reader.readAsDataURL(file);
		// Reset input so the same file can be re-picked
		e.target.value = "";
	};

	const handleCropped = (blob: Blob) => {
		setPreviewBlob(blob);
		setPreview(URL.createObjectURL(blob));
	};

	const handleUpload = async () => {
		if (!previewBlob) return;
		setUploading(true);
		setError(null);
		try {
			await accountService.uploadAvatar(previewBlob);
			setAvatarVersion(Date.now());
			setPreview(null);
			setPreviewBlob(null);
			await refresh();
			toast.success("Profile photo updated");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setUploading(false);
		}
	};

	const handleRemove = async () => {
		setRemoving(true);
		setError(null);
		try {
			await accountService.deleteAvatar();
			setAvatarVersion(Date.now());
			setPreview(null);
			setPreviewBlob(null);
			await refresh();
			toast.success("Profile photo removed");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setRemoving(false);
		}
	};

	const avatarSrc =
		user && user.has_avatar
			? accountService.avatarUrl(user.id, avatarVersion)
			: null;

	const displaySrc = preview ?? avatarSrc;

	return (
		<div className="space-y-6">
			<div>
				<div className="mb-1 flex items-center gap-2">
					<Camera className="size-4 text-primary" />
					<h2 className="text-sm font-semibold text-foreground">
						Profile photo
					</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					JPEG, PNG, GIF, or WebP · Cropped to a circle · Max 2 MB after crop
				</p>
			</div>

			<div className="flex items-center gap-5">
				{/* Avatar preview */}
				<div className="size-20 shrink-0 overflow-hidden rounded-full border-2 border-border/60 bg-sidebar-accent">
					<UserAvatar
						userId={user?.id ?? 0}
						username={user?.username ?? ""}
						hasAvatar={!!displaySrc}
						src={displaySrc ?? undefined}
						size="lg"
						className="size-full"
					/>
				</div>

				<div className="flex flex-col gap-2">
					<Button
						variant="outline"
						size="sm"
						className="gap-2"
						onClick={() => fileInputRef.current?.click()}
					>
						<Upload className="size-3.5" />
						{displaySrc ? "Replace photo" : "Upload photo"}
					</Button>
					{(user?.has_avatar || preview) && (
						<Button
							variant="ghost"
							size="sm"
							className="gap-2 text-muted-foreground hover:text-destructive"
							onClick={handleRemove}
							loading={removing}
						>
							<Trash2 className="size-3.5" />
							Remove
						</Button>
					)}
				</div>
			</div>

			{preview && (
				<div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
					<p className="flex-1 text-sm text-muted-foreground">
						Photo cropped and ready to upload.
					</p>
					<Button size="sm" onClick={handleUpload} loading={uploading}>
						Save photo
					</Button>
				</div>
			)}

			{error && <ErrorMsg message={error} />}

			<input
				ref={fileInputRef}
				type="file"
				accept="image/jpeg,image/png,image/gif,image/webp"
				className="sr-only"
				onChange={handleFileSelect}
				aria-label="Select profile photo"
			/>

			{rawSrc && (
				<CropModal
					open={cropOpen}
					onOpenChange={setCropOpen}
					imageSrc={rawSrc}
					onCropped={handleCropped}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Account tab (credentials)
// ---------------------------------------------------------------------------

function AccountTab() {
	const { user } = useAuth();
	const [usernameOpen, setUsernameOpen] = useState(false);
	const [passwordOpen, setPasswordOpen] = useState(false);

	return (
		<>
			<div className="mb-6">
				<div className="mb-1 flex items-center gap-2">
					<ShieldCheck className="size-4 text-primary" />
					<h2 className="text-sm font-semibold text-foreground">Credentials</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Changing your password signs out all other sessions.
				</p>
			</div>
			<div className="space-y-3">
				<CredRow
					icon={UserIcon}
					label="Username"
					value={user?.username ?? ""}
					onEdit={() => setUsernameOpen(true)}
				/>
				<CredRow
					icon={KeyRound}
					label="Password"
					value="hidden"
					masked
					onEdit={() => setPasswordOpen(true)}
				/>
			</div>
			<ChangeUsernameModal open={usernameOpen} onOpenChange={setUsernameOpen} />
			<ChangePasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
		</>
	);
}

// ---------------------------------------------------------------------------
// Preferences tab
// ---------------------------------------------------------------------------

type Theme = "system" | "light" | "dark";

function applyTheme(theme: Theme) {
	const root = document.documentElement;
	root.classList.remove("light", "dark");
	if (theme === "dark") root.classList.add("dark");
	else if (theme === "light") root.classList.add("light");
	else {
		if (window.matchMedia("(prefers-color-scheme: dark)").matches)
			root.classList.add("dark");
	}
	localStorage.setItem("fu_theme", theme);
}

const THEME_OPTIONS: {
	value: Theme;
	label: string;
	icon: React.ElementType;
	desc: string;
}[] = [
	{
		value: "system",
		label: "System",
		icon: Monitor,
		desc: "Follows your OS setting",
	},
	{ value: "light", label: "Light", icon: Sun, desc: "Always light mode" },
	{ value: "dark", label: "Dark", icon: Moon, desc: "Always dark mode" },
];

function PreferencesTab() {
	const [theme, setTheme] = useState<Theme>(
		() => (localStorage.getItem("fu_theme") as Theme | null) ?? "system",
	);

	const handleTheme = (t: Theme) => {
		setTheme(t);
		applyTheme(t);
	};

	return (
		<div className="space-y-6">
			<div>
				<div className="mb-1 flex items-center gap-2">
					<SlidersHorizontal className="size-4 text-primary" />
					<h2 className="text-sm font-semibold text-foreground">Appearance</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Choose how the app looks for you.
				</p>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
				{THEME_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						onClick={() => handleTheme(opt.value)}
						className={cn(
							"flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm font-medium transition-all duration-150",
							theme === opt.value
								? "border-primary/60 bg-primary/10 text-foreground"
								: "border-border/60 bg-card/30 text-muted-foreground hover:bg-card/60 hover:text-foreground",
						)}
						aria-pressed={theme === opt.value}
					>
						<opt.icon
							className={cn(
								"size-5",
								theme === opt.value ? "text-primary" : "",
							)}
						/>
						<span>{opt.label}</span>
					</button>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Danger Zone tab
// ---------------------------------------------------------------------------

function DangerConfirmModal({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: (password: string) => Promise<void>;
}) {
	const [pw, setPw] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	React.useEffect(() => {
		if (open) {
			setPw("");
			setError(null);
		}
	}, [open]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!pw) {
			setError("Password is required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onConfirm(pw);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<SubModal open={open} onOpenChange={onOpenChange} title={title}>
			<p className="mb-4 text-sm text-muted-foreground">{description}</p>
			<form onSubmit={handleSubmit} className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="danger-pw">
						Enter your current password to confirm
					</Label>
					<PasswordInput
						id="danger-pw"
						autoComplete="current-password"
						value={pw}
						onChange={(e) => setPw(e.target.value)}
						required
					/>
				</div>
				{error && <ErrorMsg message={error} />}
				<div className="flex justify-end gap-2 pt-1">
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						loading={submitting}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{confirmLabel}
					</Button>
				</div>
			</form>
		</SubModal>
	);
}

function DangerZoneTab() {
	const { logout } = useAuth();
	const navigate = useNavigate();
	const qc = useQueryClient();
	const [resetOpen, setResetOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const handleReset = async (password: string) => {
		await accountService.resetAccount(password);
		await qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
		toast.success("Account reset", {
			description: "All files and folders have been deleted.",
		});
		setResetOpen(false);
	};

	const handleDelete = async (password: string) => {
		await accountService.deleteAccount(password);
		toast.success("Account deleted");
		await logout();
		navigate("/login", { replace: true });
	};

	return (
		<div className="space-y-4">
			{/* Reset account */}
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<p className="text-sm font-semibold text-foreground">
							Reset account data
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Permanently delete all your files, folders, share links, and API
							keys. Your account and login remain intact.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={() => setResetOpen(true)}
					>
						<Trash2 className="size-3.5" />
						Reset
					</Button>
				</div>
			</div>

			{/* Delete account */}
			<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<p className="text-sm font-semibold text-destructive">
							Delete account
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Permanently delete your account and every file associated with it.
							This cannot be undone. Not available for the last master account.
						</p>
					</div>
					<Button
						size="sm"
						className="shrink-0 bg-destructive text-destructive-foreground hover:bg-destructive/90"
						onClick={() => setDeleteOpen(true)}
					>
						<Trash2 className="size-3.5" />
						Delete
					</Button>
				</div>
			</div>

			<DangerConfirmModal
				open={resetOpen}
				onOpenChange={setResetOpen}
				title="Reset account data"
				description="This will permanently delete ALL your files, folders, share links, and API keys. Your account stays active. This cannot be undone."
				confirmLabel="Yes, reset everything"
				onConfirm={handleReset}
			/>
			<DangerConfirmModal
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title="Delete account permanently"
				description="This will delete your account, all your files, folders, links, and API keys. You will be logged out immediately. This cannot be undone."
				confirmLabel="Yes, delete my account"
				onConfirm={handleDelete}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sessions tab
// ---------------------------------------------------------------------------

interface SessionInfo {
	id: string;
	ip_address: string | null;
	user_agent: string | null;
	created_at: string;
	last_seen_at: string;
	expires_at: string;
	is_current: boolean;
}

const SESSIONS_KEY = ["auth", "sessions"];

function SessionsTab() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { logout } = useAuth();
	const { data: sessions, isLoading } = useQuery({
		queryKey: SESSIONS_KEY,
		queryFn: () =>
			api
				.get<{ sessions: SessionInfo[] }>("/auth/sessions")
				.then((r) => r.sessions),
	});
	const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
	const [revokeAllOpen, setRevokeAllOpen] = useState(false);
	const [pw, setPw] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleRevokeOne = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!revokeTarget || !pw) return;
		setSubmitting(true);
		setError(null);
		try {
			await api.delete(`/auth/sessions/${revokeTarget}`, {
				json: { current_password: pw },
			});
			toast.success("Session revoked");
			setRevokeTarget(null);
			setPw("");
			qc.invalidateQueries({ queryKey: SESSIONS_KEY });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleRevokeAll = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!pw) {
			setError("Password is required.");
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await api.delete("/auth/sessions", { json: { current_password: pw } });
			toast.success("All sessions revoked");
			await logout();
			navigate("/login", { replace: true });
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSubmitting(false);
		}
	};

	function shortUA(ua: string | null) {
		if (!ua) return "Unknown browser";
		if (ua.includes("Firefox")) return "Firefox";
		if (ua.includes("Edg")) return "Edge";
		if (ua.includes("Chrome")) return "Chrome";
		if (ua.includes("Safari")) return "Safari";
		return ua.slice(0, 40);
	}

	const closeRevoke = () => {
		setRevokeTarget(null);
		setRevokeAllOpen(false);
		setPw("");
		setError(null);
	};

	return (
		<div className="space-y-4">
			<div>
				<div className="mb-1 flex items-center gap-2">
					<Laptop className="size-4 text-primary" />
					<h2 className="text-sm font-semibold text-foreground">
						Active sessions
					</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					Devices currently signed in to your account.
				</p>
			</div>

			{isLoading ? (
				<div className="space-y-2">
					<div className="h-14 w-full animate-pulse rounded-lg bg-secondary/40" />
					<div className="h-14 w-full animate-pulse rounded-lg bg-secondary/40" />
				</div>
			) : !sessions?.length ? (
				<p className="text-sm text-muted-foreground">No active sessions.</p>
			) : (
				<div className="space-y-2">
					{sessions.map((s) => (
						<div
							key={s.id}
							className={cn(
								"flex items-center gap-3 rounded-lg border px-3 py-2.5",
								s.is_current
									? "border-primary/40 bg-primary/5"
									: "border-border bg-card/30",
							)}
						>
							<Laptop className="size-4 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<p className="text-sm font-medium">
									{shortUA(s.user_agent)}
									{s.is_current && (
										<span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
											current
										</span>
									)}
								</p>
								<p className="text-xs text-muted-foreground">
									{s.ip_address || "unknown IP"} · last active{" "}
									{new Date(s.last_seen_at).toLocaleString()}
								</p>
							</div>
							{!s.is_current && (
								<Button
									variant="ghost"
									size="icon"
									className="shrink-0 text-destructive"
									onClick={() => {
										setRevokeTarget(s.id);
										setError(null);
										setPw("");
									}}
								>
									<LogOut className="size-4" />
								</Button>
							)}
						</div>
					))}
				</div>
			)}

			{/* Revoke one session */}
			<SubModal
				open={!!revokeTarget}
				onOpenChange={(o) => !o && closeRevoke()}
				title="Revoke session"
			>
				<form onSubmit={handleRevokeOne} className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Enter your password to sign out this session.
					</p>
					<div className="space-y-1.5">
						<Label>Current password</Label>
						<PasswordInput
							value={pw}
							onChange={(e) => setPw(e.target.value)}
							autoComplete="current-password"
							required
						/>
					</div>
					{error && <ErrorMsg message={error} />}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={closeRevoke}>
							Cancel
						</Button>
						<Button type="submit" loading={submitting}>
							Revoke
						</Button>
					</div>
				</form>
			</SubModal>

			{/* Revoke all sessions */}
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
				{revokeAllOpen ? (
					<form onSubmit={handleRevokeAll} className="space-y-3">
						<p className="text-sm font-medium text-foreground">
							Sign out of all sessions
						</p>
						<div className="space-y-1.5">
							<Label>Current password</Label>
							<PasswordInput
								value={pw}
								onChange={(e) => setPw(e.target.value)}
								autoComplete="current-password"
								required
							/>
						</div>
						{error && <ErrorMsg message={error} />}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={closeRevoke}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								loading={submitting}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								Sign out all
							</Button>
						</div>
					</form>
				) : (
					<div className="flex items-center justify-between gap-3">
						<p className="text-sm text-muted-foreground">
							Sign out everywhere, including this session.
						</p>
						<Button
							variant="outline"
							size="sm"
							className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
							onClick={() => {
								setRevokeAllOpen(true);
								setError(null);
								setPw("");
							}}
						>
							<LogOut className="size-3.5" /> Sign out all
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Settings sidebar nav
// ---------------------------------------------------------------------------

type SettingsTab =
	| "profile"
	| "account"
	| "security"
	| "sessions"
	| "preferences"
	| "danger";

const SETTINGS_TABS: {
	id: SettingsTab;
	label: string;
	icon: React.ElementType;
	danger?: boolean;
}[] = [
	{ id: "profile", label: "Profile", icon: Camera },
	{ id: "account", label: "Account", icon: UserIcon },
	{ id: "security", label: "Security", icon: ShieldCheck },
	{ id: "sessions", label: "Sessions", icon: Laptop },
	{ id: "preferences", label: "Preferences", icon: SlidersHorizontal },
	{ id: "danger", label: "Danger Zone", icon: TriangleAlert, danger: true },
];

// ---------------------------------------------------------------------------
// Main Settings Modal
// ---------------------------------------------------------------------------

export function SettingsModal({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [activeTab, setActiveTab] = useState<SettingsTab>("profile");

	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content
					className={cn(
						"fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
						"w-[min(90vw,700px)] h-[min(90dvh,500px)]",
						"flex flex-col md:flex-row overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl shadow-black/40 backdrop-blur-xl",
						"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-200",
					)}
				>
					{/* Left sidebar */}
					<aside className="flex w-full shrink-0 flex-col border-b border-border/60 bg-sidebar/60 p-3 md:w-48 md:border-b-0 md:border-r">
						<div className="mb-4 flex items-center gap-2.5 px-2 py-1">
							<Settings className="size-4 text-muted-foreground" />
							<span className="text-sm font-semibold tracking-tight text-foreground">
								Settings
							</span>
						</div>
						<nav className="flex flex-row overflow-x-auto gap-0.5 md:flex-col">
							{SETTINGS_TABS.map((tab) => (
								<button
									key={tab.id}
									onClick={() => setActiveTab(tab.id)}
									className={cn(
										"flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 text-left",
										"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
										tab.danger
											? activeTab === tab.id
												? "bg-destructive/15 text-destructive"
												: "text-destructive/70 hover:bg-destructive/10 hover:text-destructive"
											: activeTab === tab.id
												? "bg-sidebar-accent text-sidebar-accent-foreground"
												: "text-muted-foreground",
									)}
								>
									<tab.icon className="size-4 shrink-0" />
									{tab.label}
								</button>
							))}
						</nav>
					</aside>

					{/* Right content */}
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="flex items-center justify-between border-b border-border/60 px-6 py-4">
							<DialogPrimitive.Title
								className={cn(
									"flex items-center gap-2 text-base font-semibold",
									activeTab === "danger"
										? "text-destructive"
										: "text-foreground",
								)}
							>
								{(() => {
									const t = SETTINGS_TABS.find((t) => t.id === activeTab);
									return t ? (
										<>
											<t.icon className="size-4 shrink-0" />
											{t.label}
										</>
									) : null;
								})()}
							</DialogPrimitive.Title>
							<DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
								<X className="size-4" />
								<span className="sr-only">Close</span>
							</DialogPrimitive.Close>
						</div>
						<div className="flex-1 overflow-y-auto p-6">
							{activeTab === "profile" && <ProfileTab />}
							{activeTab === "account" && <AccountTab />}
							{activeTab === "security" && <SecurityTab />}
							{activeTab === "sessions" && <SessionsTab />}
							{activeTab === "preferences" && <PreferencesTab />}
							{activeTab === "danger" && <DangerZoneTab />}
						</div>
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
