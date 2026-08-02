import { KeyRound } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { AuthorizedAppsSection } from "@/features/oauth/components/AuthorizedAppsSection";
import { OauthAppsSection } from "@/features/oauth/components/OauthAppsSection";
import { ApiKeysSection } from "./ApiKeysSection";

export function ApiKeysPage() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="API access"
				subtitle="API keys for your own scripts, OAuth apps for everyone else's."
				icon={KeyRound}
			/>
			<ApiKeysSection />
			<OauthAppsSection />
			<AuthorizedAppsSection />
		</div>
	);
}
