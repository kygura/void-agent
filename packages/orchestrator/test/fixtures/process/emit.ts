const mode = process.argv[2] ?? "lines";

if (mode === "lines") {
	process.stdout.write("first\nsec");
	await Bun.sleep(10);
	process.stdout.write("ond\r\nfinal");
} else if (mode === "bounded") {
	process.stdout.write("x".repeat((1 << 20) + 4096));
	process.stdout.write("\nafter\n");
	process.stderr.write(`discarded-${"e".repeat((8 << 10) + 4096)}-tail`);
} else if (mode === "nonzero") {
	process.stderr.write("fixture failed\n");
	process.exit(7);
} else {
	process.stderr.write(`unknown emit mode: ${mode}\n`);
	process.exit(2);
}
