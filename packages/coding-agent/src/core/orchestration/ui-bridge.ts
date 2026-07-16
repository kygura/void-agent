import type { ProcessLifetimeOrchestrationHost } from "./host.js";

export interface OrchestrationUiController {
	openAgents(): void;
	openChild(targetId: string): void;
	requestCancel(targetId: string): void;
	requestRender(): void;
	focusedChildSessionId(): string | undefined;
	focusedRunId(): string | undefined;
}

let activeHost: ProcessLifetimeOrchestrationHost | undefined;
let activeController: OrchestrationUiController | undefined;

export function setActiveOrchestrationHost(host: ProcessLifetimeOrchestrationHost): void {
	activeHost = host;
}

export function getActiveOrchestrationHost(): ProcessLifetimeOrchestrationHost | undefined {
	return activeHost;
}

export function installOrchestrationUiController(controller: OrchestrationUiController): () => void {
	activeController = controller;
	return () => {
		if (activeController === controller) activeController = undefined;
	};
}

export function getOrchestrationUiController(): OrchestrationUiController | undefined {
	return activeController;
}
