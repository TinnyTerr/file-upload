import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { PreviewMedia } from "@/features/download/components/FilePreview";
import { previewPath } from "@/features/download/services/publicService";
import type { PublicDirMember } from "../services/publicDirService";

/** Inline preview for a single file inside a folder listing -- same eligibility
 * rules as the single-file download page (unencrypted, unlimited-use link). */
export function FolderFilePreviewModal({
	member,
	open,
	onOpenChange,
}: {
	member: PublicDirMember | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				{member && (
					<>
						<DialogHeader>
							<DialogTitle className="truncate">{member.filename}</DialogTitle>
						</DialogHeader>
						<PreviewMedia
							src={previewPath(member.slug)}
							contentType={member.content_type}
							filename={member.filename}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
