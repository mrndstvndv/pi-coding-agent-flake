import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises";

export type AtomicWriteOperations = {
	writeFile: (filePath: string, content: string, encoding: "utf-8") => Promise<void>;
	stat: (filePath: string) => Promise<{ mode: number }>;
	chmod: (filePath: string, mode: number) => Promise<void>;
	rename: (fromPath: string, toPath: string) => Promise<void>;
	unlink: (filePath: string) => Promise<void>;
};

const ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = {
	writeFile,
	stat,
	chmod,
	rename,
	unlink,
};

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export async function writeFileAtomic(
	absPath: string,
	content: string,
	operations: AtomicWriteOperations = ATOMIC_WRITE_OPERATIONS,
	preserveMode?: number,
): Promise<void> {
	const tempPath = `${absPath}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	let existingMode = preserveMode;
	if (existingMode === undefined) {
		try {
			existingMode = (await operations.stat(absPath)).mode & 0o7777;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
	}

	await operations.writeFile(tempPath, content, "utf-8");
	if (existingMode !== undefined) {
		await operations.chmod(tempPath, existingMode);
	}
	try {
		await operations.rename(tempPath, absPath);
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) {
			throw error;
		}
		await operations.unlink(absPath);
		await operations.rename(tempPath, absPath);
	}
}
