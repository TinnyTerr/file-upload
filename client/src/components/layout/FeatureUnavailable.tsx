import { Construction } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** Shown in place of a page/route whose backend routes aren't ported to the Bun server yet. */
export function FeatureUnavailable({ label }: { label: string }) {
  return (
    <EmptyState
      icon={Construction}
      title={`${label} isn't available yet`}
      description="This feature is being ported to the new Bun + Express backend. Check back once it lands."
      className="min-h-[60vh]"
    />
  );
}
