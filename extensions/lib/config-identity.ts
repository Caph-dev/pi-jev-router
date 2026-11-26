import type { RouterConfig } from "./router-config.ts";

export function routingConfigIdentity(config: RouterConfig): string {
	return JSON.stringify([config.provider, config.models.complex, config.models.standard,
		config.models.implementation, config.threshold, config.promptLimit, config.adaptive, config.classifier]);
}

export function matchesConfigIgnoringDirect(saved: string, current: string): boolean {
	if (saved === current) return true;
	try {
		const legacy: unknown = JSON.parse(saved);
		if (!Array.isArray(legacy) || legacy.length !== 9 ||
			(legacy[4] !== null && (typeof legacy[4] !== "string" || !legacy[4].trim()))) return false;
		// Older identities included the direct slot between implementation and threshold.
		return JSON.stringify([...legacy.slice(0, 4), ...legacy.slice(5)]) === current;
	} catch {
		return false;
	}
}
