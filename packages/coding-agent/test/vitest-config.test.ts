import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

describe("Vitest configuration", () => {
	it("rejects committed focused tests", () => {
		expect(config).toMatchObject({ test: { allowOnly: false } });
	});
});
