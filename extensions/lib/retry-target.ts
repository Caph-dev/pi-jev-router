import type { RouterConfig } from "./router-config.ts";
import type { RouterRequest } from "./adaptive-routing.ts";

export function selectRetryTarget(request: RouterRequest, config: RouterConfig, savedModel: string | undefined,
	exists: (id: string) => boolean, previousPlanning: string | undefined) {
	const failed = request.failed;
	const { complex, standard, implementation, direct } = config.models;
	if (failed?.model.provider === config.provider &&
		[complex, standard, implementation, direct, savedModel].includes(failed.model.id) && exists(failed.model.id)) {
		return { id: failed.model.id, keepsFailed: true, thinkingLevel: failed.thinkingLevel };
	}
	return { id: savedModel ?? previousPlanning ?? standard, keepsFailed: false, thinkingLevel: undefined };
}
