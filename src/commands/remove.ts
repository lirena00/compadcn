import {
  intro,
  outro,
  note,
  multiselect,
  confirm,
  isCancel,
} from "@clack/prompts";
import { log } from "@clack/prompts";
import chalk from "chalk";
import { getInstalledComponents } from "../utils/getInstalledComponents.js";
import { removeComponents } from "../utils/removeComponents.js";
import { removeImportsFromFiles } from "../utils/removeImports.js";
import { removeDependencies } from "../utils/removeDependencies.js";
import { allComponents } from "../lib/components.js";

export async function runRemoveUI(componentsToRemove?: string[]) {
  intro(chalk.bgRed("Remove Components"));

  try {
    log.step("Fetching installed components...");
    const installedComponents = await getInstalledComponents();

    if (installedComponents.length === 0) {
      outro(
        chalk.yellow(
          "No ShadCN components found. Make sure you have components installed."
        )
      );
      return;
    }

    let finalComponentsToRemove: string[] = [];

    if (componentsToRemove && componentsToRemove.length > 0) {
      const invalidComponents = componentsToRemove.filter(
        (comp) => !installedComponents.includes(comp)
      );

      if (invalidComponents.length > 0) {
        log.error(
          chalk.red(
            `The following components are not installed: ${invalidComponents.join(
              ", "
            )}`
          )
        );
        outro(chalk.red("Cannot proceed with removal."));
        return;
      }

      finalComponentsToRemove = componentsToRemove;
    } else {
      const selectedComponents = await multiselect({
        message: `Select components to remove:
${chalk.gray(
  "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
)}`,
        options: installedComponents.map((comp) => ({
          label: allComponents.find((c) => c.value === comp)?.label || comp,
          value: comp,
        })),
        maxItems: 10,
        initialValues: [],
      });

      if (isCancel(selectedComponents)) {
        outro(chalk.yellow("Cancelled"));
        return;
      }

      finalComponentsToRemove = selectedComponents as string[];
    }

    if (finalComponentsToRemove.length === 0) {
      outro(chalk.yellow("No components selected for removal."));
      return;
    }

    // Check for internal dependency conflicts
    const conflictResult = checkInternalDependencyConflicts(
      finalComponentsToRemove,
      installedComponents
    );

    if (conflictResult.hasConflicts) {
      log.error(
        chalk.red("Cannot remove components due to internal dependencies:")
      );

      conflictResult.conflicts.forEach(({ component, dependentComponents }) => {
        console.log(
          chalk.red(
            `  • ${component} is required by: ${dependentComponents.join(", ")}`
          )
        );
      });

      log.error(
        chalk.red(
          "To remove these components, you must also remove the components that depend on them."
        )
      );

      outro(chalk.red("Cannot proceed with removal."));
      return;
    }

    // Show components to be removed
    const componentLabels = finalComponentsToRemove
      .map((comp) => {
        const component = allComponents.find((c) => c.value === comp);
        return `  • ${component?.label || comp}`;
      })
      .join("\n");

    note(
      `${chalk.red("Components to be removed:")}\n${componentLabels}`,
      `${finalComponentsToRemove.length} components`
    );

    const dependenciesToRemove = getDependenciesForComponents(
      finalComponentsToRemove,
      installedComponents
    );
    let selectedDependencies = [] as string[];

    if (dependenciesToRemove.length > 0) {
      const dependencySelection = await multiselect({
        message: `Select dependencies to remove (optional):
    ${chalk.gray(
      "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
    )}
    ${chalk.gray("Leave empty to skip dependency removal")}`,
        options: dependenciesToRemove.map((dep) => ({
          label: dep,
          value: dep,
        })),
        maxItems: 10,
        initialValues: [],
        required: false,
      });

      if (isCancel(dependencySelection)) {
        outro(chalk.yellow("Cancelled"));
        return;
      }

      selectedDependencies = dependencySelection as string[];
    }

    // Single confirmation for both components and dependencies
    const proceed = await confirm({
      message: chalk.yellow(
        `Are you sure you want to remove ${
          finalComponentsToRemove.length
        } components${
          selectedDependencies.length > 0
            ? ` and ${selectedDependencies.length} dependencies`
            : ""
        }?`
      ),
      initialValue: false,
    });

    if (isCancel(proceed) || !proceed) {
      outro(chalk.yellow("Cancelled"));
      return;
    }

    // Execute removal operations
    await removeComponents(finalComponentsToRemove);
    await removeImportsFromFiles(finalComponentsToRemove);

    if (selectedDependencies.length > 0) {
      await removeDependencies(selectedDependencies);
    }

    outro(
      chalk.green(
        `Successfully removed ${finalComponentsToRemove.length} components${
          selectedDependencies.length > 0
            ? ` and ${selectedDependencies.length} dependencies`
            : ""
        }!`
      )
    );
  } catch (error) {
    log.error(chalk.red("Error during component removal"));
    console.error(error);
    outro(chalk.red("Failed to remove components."));
  }
}

function getDependenciesForComponents(
  componentNames: string[],
  installedComponents: string[]
): string[] {
  const dependenciesToRemove = new Set<string>();
  const allDependencies = new Set<string>();

  // First, collect all dependencies from components being removed
  componentNames.forEach((componentName) => {
    const component = allComponents.find((c) => c.value === componentName);
    if (component) {
      component.dependencies.forEach((dep) => {
        allDependencies.add(dep);
        dependenciesToRemove.add(dep);
      });
    }
  });

  // Then, check if any of these dependencies are also used by components that are NOT being removed
  const remainingComponents = installedComponents.filter(
    (comp) => !componentNames.includes(comp)
  );

  remainingComponents.forEach((componentName) => {
    const component = allComponents.find((c) => c.value === componentName);
    if (component) {
      component.dependencies.forEach((dep) => {
        if (dependenciesToRemove.has(dep)) {
          // This dependency is used by a component that's staying, so don't remove it
          dependenciesToRemove.delete(dep);
        }
      });
    }
  });

  return Array.from(dependenciesToRemove);
}

interface ConflictResult {
  hasConflicts: boolean;
  conflicts: Array<{
    component: string;
    dependentComponents: string[];
  }>;
}

function checkInternalDependencyConflicts(
  componentsToRemove: string[],
  installedComponents: string[]
): ConflictResult {
  const conflicts: Array<{
    component: string;
    dependentComponents: string[];
  }> = [];

  // For each component to be removed, check if any installed component depends on it
  componentsToRemove.forEach((componentToRemove) => {
    const dependentComponents: string[] = [];

    // Check all installed components
    installedComponents.forEach((installedComponent) => {
      // Skip if this component is also being removed
      if (componentsToRemove.includes(installedComponent)) {
        return;
      }

      // Find the component definition
      const componentDef = allComponents.find(
        (c) => c.value === installedComponent
      );

      if (
        componentDef &&
        componentDef.internal_dependencies.includes(componentToRemove)
      ) {
        dependentComponents.push(installedComponent);
      }
    });

    if (dependentComponents.length > 0) {
      conflicts.push({
        component: componentToRemove,
        dependentComponents,
      });
    }
  });

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}
