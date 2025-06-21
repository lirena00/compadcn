import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { spinner } from "@clack/prompts";
import chalk from "chalk";

export async function removeImportsFromFiles(
  componentNames: string[]
): Promise<void> {
  const s = spinner();
  s.start("Removing imports from files...");

  try {
    const filesToCheck = await getAllFiles();
    let modifiedCount = 0;

    for (const filePath of filesToCheck) {
      let content = readFileSync(filePath, "utf-8");
      let newContent = content;

      for (const componentName of componentNames) {
        // Remove import statements for the component
        const importRegex = new RegExp(
          `import\\s+{[^}]*}\\s+from\\s+['"][^'"]*\\/components\\/ui\\/${componentName}['"];?`,
          "g"
        );
        newContent = newContent.replace(importRegex, "");

        // Also remove any leftover empty import lines
        newContent = newContent.replace(
          /^\s*import\s+{\s*}\s+from[^;]+;?\s*$/gm,
          ""
        );
      }

      // Clean up multiple consecutive empty lines
      newContent = newContent.replace(/\n\s*\n\s*\n/g, "\n\n");

      if (newContent !== content) {
        writeFileSync(filePath, newContent, "utf-8");
        modifiedCount++;
      }
    }

    s.stop(chalk.green(`Cleaned imports from ${modifiedCount} files`));
  } catch (error) {
    s.stop(chalk.red("Failed to remove imports"));
    throw error;
  }
}

async function getAllFiles(): Promise<string[]> {
  const filesToCheck: string[] = [];
  const srcDirs = ["src", "app", "pages", "components"];
  const excludeDirs = ["node_modules", ".next", "dist", "build", ".git"];

  const walkDir = (dir: string) => {
    try {
      const items = readdirSync(dir);

      for (const item of items) {
        const itemPath = join(dir, item);
        const stat = statSync(itemPath);

        if (stat.isDirectory()) {
          if (!excludeDirs.includes(item)) {
            walkDir(itemPath);
          }
        } else if (
          stat.isFile() &&
          (item.endsWith(".tsx") ||
            item.endsWith(".ts") ||
            item.endsWith(".jsx") ||
            item.endsWith(".js"))
        ) {
          filesToCheck.push(itemPath);
        }
      }
    } catch (error) {
      // Ignore errors for directories that don't exist
    }
  };

  for (const dir of srcDirs) {
    const dirPath = join(process.cwd(), dir);
    walkDir(dirPath);
  }

  return filesToCheck;
}
