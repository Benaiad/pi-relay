import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export const findPackageRoot = (startDir: string): string | null => {
	let dir: string;
	try {
		dir = realpathSync(startDir);
	} catch {
		return null;
	}
	for (;;) {
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				if (pkg.pi?.extensions) return dir;
			} catch {
				// Not our package.json, keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};
