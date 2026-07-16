const ignoreTerm = process.argv.includes("--ignore-term");

process.on("SIGTERM", () => {
	process.stdout.write("term\n");
	if (!ignoreTerm) process.exit(0);
});

process.stdout.write("ready\n");
setInterval(() => {}, 1000);
