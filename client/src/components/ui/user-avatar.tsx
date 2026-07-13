import { cn } from "@/lib/cn";
import { accountService } from "@/features/account/services/accountService";

const SIZE_CLASSES = {
  sm: "size-6 text-xs font-semibold",
  md: "size-9 text-xs font-semibold",
  lg: "size-20 text-xl font-bold",
} as const;

export interface UserAvatarProps {
  userId: number;
  username: string;
  hasAvatar: boolean;
  /** sm = size-6 (inline uploader rows), md = size-9 (list rows), lg = size-20 (profile editor). */
  size?: keyof typeof SIZE_CLASSES;
  /** Cache-busting version param appended to the built-in avatar URL. */
  version?: number;
  /** Explicit image source (e.g. a local object URL preview) — overrides the built-in `/account/avatar/:id` URL. */
  src?: string;
  className?: string;
}

/** Shows the user's avatar image if present, else a gradient-initials fallback. */
export function UserAvatar({ userId, username, hasAvatar, size = "md", version, src, className }: UserAvatarProps) {
  const resolvedSrc = src ?? (hasAvatar ? accountService.avatarUrl(userId, version) : undefined);

  if (hasAvatar && resolvedSrc) {
    return (
      <img
        src={resolvedSrc}
        alt={username}
        className={cn(SIZE_CLASSES[size].split(" ")[0], "shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-brand-gradient text-white",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {username.slice(0, 2).toUpperCase()}
    </span>
  );
}
