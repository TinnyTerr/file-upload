import { passwordStrength, type StrengthLabel } from "@/lib/passwordStrength";
import { Progress } from "./progress";

const LABEL: Record<StrengthLabel, string> = {
	weak: "Weak",
	fair: "Fair",
	good: "Good",
	strong: "Strong",
};

const INDICATOR_CLASS: Record<StrengthLabel, string> = {
	weak: "bg-destructive",
	fair: "bg-warning",
	good: "bg-primary",
	strong: "bg-success",
};

/** Hidden for an empty password -- there's nothing to rate yet, and showing
 * a zeroed-out bar before the first keystroke reads as a validation error. */
export function PasswordStrengthMeter({ password }: { password: string }) {
	if (!password) return null;
	const { score, label } = passwordStrength(password);

	return (
		<div className="space-y-1">
			<Progress
				value={score}
				className="h-1.5"
				indicatorClassName={INDICATOR_CLASS[label]}
				aria-label="Password strength"
			/>
			<p className="text-xs text-muted-foreground">{LABEL[label]}</p>
		</div>
	);
}
