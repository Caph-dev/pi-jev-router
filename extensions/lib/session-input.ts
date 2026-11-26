import type { RouterConfig } from "../jev-router.ts";
import type { AdaptiveState, Branch, Projection } from "./adaptive-routing.ts";

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
}

export function currentUser(projection: Projection): { id: string; text: string; hasImages: boolean } | undefined {
	const entry = projection.entries.findLast(({ sourceEntry }) => sourceEntry.type === "message" && sourceEntry.message.role === "user");
	if (!entry) return undefined;
	return { id: entry.sourceEntry.id, text: entry.messages.filter(message => message.role === "user").map(message => textContent(message.content)).join("\n"),
		hasImages: entry.messages.some(message => message.role === "user" && Array.isArray(message.content) && message.content.some(block => block.type === "image")) };
}

/** Both boundaries are persistent IDs on this branch, never message indexes. */
export function hasSuccessfulWriteAfterBoundary(branch: Branch, state: Pick<AdaptiveState, "stageStartEntryId" | "lastEvaluatedUserEntryId">, userId: string | undefined, tools: readonly string[]): boolean {
	if (!userId || userId !== state.lastEvaluatedUserEntryId) return false;
	const anchor = branch.findIndex(entry => entry.id === state.stageStartEntryId);
	const user = branch.findIndex(entry => entry.id === userId);
	if (anchor < 0 || user < 0) return false;
	return branch.slice(Math.max(anchor, user) + 1).some(entry => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
		const message = entry.message;
		return (tools.includes(message.toolName) && message.isError === false) ||
			Boolean(message.nestedCalls?.calls.some(call => tools.includes(call.name) && call.status === "ok"));
	});
}

type RecentTurn = { user: string; assistant: string[] };
export type ClassifierInput = { current: string; recentTurns?: RecentTurn[]; historyPartial?: boolean };

export function buildClassifierInput(config: RouterConfig, projection: Projection, branch: Branch,
	user: ReturnType<typeof currentUser>): ClassifierInput {
	const current = (user?.text ?? "").slice(0, config.promptLimit);
	let historyPartial = branch.some(entry => ["compaction", "context_edit", "branch_summary"].includes(entry.type));
	const turns: RecentTurn[] = [];
	let turn: RecentTurn | undefined;
	let successful = false;
	const close = () => {
		if (turn && turn.user.trim() && successful) turns.push(turn);
		else if (turn) historyPartial = true;
	};
	for (const { sourceEntry, messages } of projection.entries) {
		if (sourceEntry.id === user?.id) break;
		if (["compaction", "context_edit", "branch_summary"].includes(sourceEntry.type)) historyPartial = true;
		if (sourceEntry.type !== "message") continue;
		if (sourceEntry.message.role === "user") {
			close();
			turn = { user: messages.filter(message => message.role === "user").map(message => textContent(message.content)).join("\n"), assistant: [] };
			successful = false;
		} else if (sourceEntry.message.role === "assistant") {
			if (!turn || messages.length === 0) historyPartial = true;
			for (const message of messages) {
				if (message.role !== "assistant") continue;
				if (!["stop", "toolUse"].includes(message.stopReason)) { historyPartial = true; continue; }
				if (!turn) continue;
				successful = true;
				const text = textContent(message.content);
				if (text) turn.assistant.push(text);
			}
		}
	}
	close();
	const recentTurns: RecentTurn[] = [];
	let chars = 0;
	for (const item of turns.toReversed()) {
		const size = item.user.length + item.assistant.reduce((total, text) => total + text.length, 0);
		if (recentTurns.length >= config.adaptive.historyMaxTurns || chars + size > config.adaptive.historyCharLimit) {
			historyPartial = true;
			break;
		}
		chars += size;
		recentTurns.unshift(item);
	}
	if (!user) historyPartial = true;
	return { current, recentTurns, historyPartial };
}
