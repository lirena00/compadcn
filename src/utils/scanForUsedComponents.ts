import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spinner } from "@clack/prompts";
import chalk from "chalk";

export async function scanForUsedComponents(
  installedComponents: string[]
): Promise<string[]> {
  const s = spinner();
  s.start("Scanning codebase for component usage...");

  try {
    const usedComponents = new Set<string>();
    const excludeDirs = ["node_modules", ".next", "dist", "build", ".git"];
    const scanDirs = ["src", "app", "pages", "components"];

    for (const dir of scanDirs) {
      const dirPath = join(process.cwd(), dir);
      if (existsSync(dirPath)) {
        scanDirectory(
          dirPath,
          installedComponents,
          usedComponents,
          excludeDirs
        );
      }
    }

    s.stop(chalk.green("Scan completed"));
    return Array.from(usedComponents);
  } catch (error) {
    s.stop(chalk.red("Scan failed"));
    throw error;
  }
}

function scanDirectory(
  dirPath: string,
  installedComponents: string[],
  usedComponents: Set<string>,
  excludeDirs: string[]
): void {
  try {
    const items = readdirSync(dirPath);

    for (const item of items) {
      const itemPath = join(dirPath, item);
      const stat = statSync(itemPath);

      if (stat.isDirectory()) {
        if (!excludeDirs.includes(item)) {
          scanDirectory(
            itemPath,
            installedComponents,
            usedComponents,
            excludeDirs
          );
        }
      } else if (
        stat.isFile() &&
        (item.endsWith(".tsx") ||
          item.endsWith(".ts") ||
          item.endsWith(".jsx") ||
          item.endsWith(".js"))
      ) {
        scanFile(itemPath, installedComponents, usedComponents);
      }
    }
  } catch (error) {}
}

function scanFile(
  filePath: string,
  installedComponents: string[],
  usedComponents: Set<string>
): void {
  try {
    const content = readFileSync(filePath, "utf-8");

    for (const component of installedComponents) {
      // Check for import patterns first
      const importPatterns = [
        new RegExp(
          `import\\s+{[^}]*}\\s+from\\s+['"][^'"]*\\/components\\/ui\\/${component}['"];?`,
          "g"
        ),
      ];

      const isImported = importPatterns.some((pattern) =>
        pattern.test(content)
      );

      if (isImported) {
        usedComponents.add(component);
      }
    }
  } catch (error) {}
}
