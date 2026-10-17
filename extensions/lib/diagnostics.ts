import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Safe, shared accounting and failure projection. Never return provider text or metadata. */
export function finiteNonnegative(value: unknown): number | null {
 return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function safeUsage(raw: any) {
 if (!raw || typeof raw !== "object") return "unknown" as const;
 const cost = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "total"].map(key => [key, finiteNonnegative(raw.cost?.[key])]));
 // Catalogs use all-zero prices for unpriced models too. Zero usage/price cannot establish free billing.
 const estimated = Object.values(cost).some(value => value !== null && value > 0);
 return {
  input: finiteNonnegative(raw.input), output: finiteNonnegative(raw.output),
  cacheRead: finiteNonnegative(raw.cacheRead), cacheWrite: finiteNonnegative(raw.cacheWrite),
  cacheWrite1h: finiteNonnegative(raw.cacheWrite1h), reasoning: finiteNonnegative(raw.reasoning),
  totalTokens: finiteNonnegative(raw.totalTokens),
  costSource: estimated ? "catalog-estimate" : "unknown", cost: estimated ? cost : null,
 };
}

export function failureCategory(stopReason: unknown, error: unknown): string | null {
 if (stopReason === "aborted") return "cancelled";
 if (stopReason !== "error") return null;
 const text = typeof error === "string" ? error : "";
 if (/timeout|timed out|deadline/i.test(text)) return "timeout";
 if (/overload|overloaded|capacity|server_error/i.test(text)) return "overloaded";
 if (/rate.limit|too many requests|\b429\b/i.test(text)) return "rate-limit";
 if (/unauthori[sz]ed|forbidden|api.?key|\b40[13]\b/i.test(text)) return "authentication";
 if (/context.{0,30}(length|limit|window)|too many tokens/i.test(text)) return "context-limit";
 if (/network|fetch failed|econnreset|enotfound/i.test(text)) return "network";
 return "provider-error";
}


/** Diagnostics cannot change a routing decision or expose raw persistence/provider errors. */
export function diagnosticFailure(): void {
	try { console.error("[pi-jev-router] diagnostics-unavailable"); } catch { /* best effort */ }
}

export function createDiagnostics(pi: ExtensionAPI, enabled: boolean) {
	let pending: { decisionId: string; provider: string; model: string; started: number; sessionId: string } | undefined;
	if (enabled && typeof pi.on === "function") {
		pi.on("message_end", (event, ctx) => {
			const message = event.message;
			if (message.role !== "assistant" || !pending || message.provider !== pending.provider || message.model !== pending.model) return;
			const item = pending; pending = undefined;
			if (ctx.sessionManager.getSessionId() !== item.sessionId || !ctx.sessionManager.getBranch().some(entry =>
				entry.type === "custom" && entry.customType === "pi-jev-router.decision" &&
				(entry.data as { decisionId?: unknown })?.decisionId === item.decisionId)) return;
			const level = (message as { thinkingLevel?: unknown }).thinkingLevel;
			try {
				pi.appendEntry("pi-jev-router.outcome", {
					schemaVersion: 1, decisionId: item.decisionId, provider: item.provider, model: item.model,
					stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason) ? message.stopReason : "unknown",
					succeeded: message.stopReason === "stop" || message.stopReason === "toolUse",
					failureCategory: failureCategory(message.stopReason, message.errorMessage),
					actualThinkingLevel: typeof level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level) ? level : null,
					elapsedMs: finiteNonnegative(performance.now() - item.started), usage: safeUsage(message.usage),
				});
			} catch { diagnosticFailure(); }
		});
		const clear = () => { pending = undefined; };
		pi.on("agent_end", clear);
		pi.on("session_start", clear);
		pi.on("session_before_switch", clear);
		pi.on("session_tree", clear);
		pi.on("session_shutdown", clear);
	}
	return (ctx: ExtensionContext, decision: Record<string, unknown>, model: { provider: string; id: string }) => {
		if (!enabled || decision.requestReason === "direct") return;
		pending = undefined;
		try {
			const decisionId = randomUUID();
			pi.appendEntry("pi-jev-router.decision", { schemaVersion: 1, ...decision, decisionId });
			pending = { decisionId, provider: model.provider, model: model.id, started: performance.now(), sessionId: ctx.sessionManager.getSessionId() };
		} catch { diagnosticFailure(); }
	};
}
