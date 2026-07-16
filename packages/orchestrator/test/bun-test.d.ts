declare module "bun:test" {
	interface Matchers {
		toBe(expected: unknown): void;
		toBeNull(): void;
		toBeUndefined(): void;
		toEqual(expected: unknown): void;
		toMatchObject(expected: object): void;
	}

	interface Expect {
		<T>(actual: T): Matchers;
		arrayContaining(values: readonly unknown[]): unknown;
	}

	export const describe: (name: string, callback: () => void) => void;
	export const expect: Expect;
	export const test: (name: string, callback: () => void | Promise<void>) => void;
}

declare const Bun: {
	sleep(ms: number): Promise<void>;
	spawn(
		argv: string[],
		options?: {
			detached?: boolean;
			stdin?: string;
			stdout?: string;
			stderr?: string;
		},
	): { pid: number };
};
