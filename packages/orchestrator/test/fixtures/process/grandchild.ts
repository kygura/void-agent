import { fileURLToPath } from "node:url";

const sleepFixture = fileURLToPath(new URL("./sleep.ts", import.meta.url));
const grandchild = Bun.spawn([process.execPath, sleepFixture, "--ignore-term"], {
	detached: false,
	stdin: "ignore",
	stdout: "ignore",
	stderr: "ignore",
});

process.on("SIGTERM", () => {
	// The fixture deliberately requires the process engine's SIGKILL escalation.
});

process.stdout.write(`${grandchild.pid}\n`);
setInterval(() => {}, 1000);
