const mode = process.argv[2] ?? "";

switch (mode) {
	case "clean-result":
		process.stdout.write('{"result":"done"}\n');
		break;
	case "duplicate-result":
		process.stdout.write('{"result":"first"}\n{"result":"second"}\n');
		break;
	case "resultless":
		process.stdout.write("hello\n");
		break;
	case "error":
		process.stdout.write("partial\n");
		process.stderr.write("fake provider failed\n");
		process.exitCode = 7;
		break;
	default:
		process.stderr.write("unknown fake mode\n");
		process.exitCode = 2;
}
