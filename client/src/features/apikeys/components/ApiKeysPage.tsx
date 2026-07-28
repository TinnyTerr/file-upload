import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ApiKeysSection } from "./ApiKeysSection";

export function ApiKeysPage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="API keys"
				subtitle="Create and manage API keys for programmatic access."
				icon={KeyRound}
			/>
			<ApiKeysSection />
		</div>
	);
}
