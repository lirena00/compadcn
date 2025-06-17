// src/commands/init.ts
import {
  intro,
  outro,
  spinner,
  multiselect,
  confirm,
  isCancel,
  note,
} from "@clack/prompts";
import chalk from "chalk";
import { renderTitle } from "../utils/renderTitle.js";
import { getUserPkgManager } from "../utils/getUserPkgManager.js";
import { buildInstallCommand } from "../utils/buildInstallCommand.js";
import { installComponents } from "../utils/installComponents.js";

export async function runInitUI() {
  renderTitle();

  const components = await multiselect({
    message: `Pick the components to install:
${chalk.gray(
  "Use [arrows] to navigate, [space] to toggle, [a] to toggle all, [enter] to confirm"
)}`,
    options: [
      { label: "Accordion", value: "accordion" },
      { label: "Alert", value: "alert" },
      { label: "Alert Dialog", value: "alert-dialog" },
      { label: "Aspect Ratio", value: "aspect-ratio" },
      { label: "Avatar", value: "avatar" },
      { label: "Badge", value: "badge" },
      { label: "Breadcrumb", value: "breadcrumb" },
      { label: "Button", value: "button" },
      { label: "Calendar", value: "calendar" },
      { label: "Card", value: "card" },
      { label: "Carousel", value: "carousel" },
      { label: "Chart", value: "chart" },
      { label: "Checkbox", value: "checkbox" },
      { label: "Collapsible", value: "collapsible" },
      { label: "Combobox", value: "combobox" },
      { label: "Command", value: "command" },
      { label: "Context Menu", value: "context-menu" },
      { label: "Data Table", value: "data-table" },
      { label: "Date Picker", value: "date-picker" },
      { label: "Dialog", value: "dialog" },
      { label: "Drawer", value: "drawer" },
      { label: "Dropdown Menu", value: "dropdown-menu" },
      { label: "Hover Card", value: "hover-card" },
      { label: "Input", value: "input" },
      { label: "Input OTP", value: "input-otp" },
      { label: "Label", value: "label" },
      { label: "Menubar", value: "menubar" },
      { label: "Navigation Menu", value: "navigation-menu" },
      { label: "Pagination", value: "pagination" },
      { label: "Popover", value: "popover" },
      { label: "Progress", value: "progress" },
      { label: "Radio Group", value: "radio-group" },
      { label: "Resizable", value: "resizable" },
      { label: "Scroll-area", value: "scroll-area" },
      { label: "Select", value: "select" },
      { label: "Separator", value: "separator" },
      { label: "Sheet", value: "sheet" },
      { label: "Sidebar", value: "sidebar" },
      { label: "Skeleton", value: "skeleton" },
      { label: "Slider", value: "slider" },
      { label: "Sonner", value: "sonner" },
      { label: "Switch", value: "switch" },
      { label: "Table", value: "table" },
      { label: "Tabs", value: "tabs" },
      { label: "Textarea", value: "textarea" },
      { label: "Toggle", value: "toggle" },
      { label: "Toggle Group", value: "toggle-group" },
      { label: "Tooltip", value: "tooltip" },
    ],
    maxItems: 15,
    initialValues: [],
  });

  if (isCancel(components)) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  // Check if any components are selected
  if ((components as string[]).length === 0) {
    outro(chalk.yellow("No components selected. Installation cancelled."));
    return;
  }

  // Show selected components
  const componentLabels = (components as string[])
    .map((comp) => `  • ${comp}`)
    .join("\n");

  const packageManager = getUserPkgManager();
  const command = buildInstallCommand(packageManager, components as string[]);

  note(
    `${chalk.green("Selected components:")}\n${componentLabels}

${chalk.gray("Command to be executed:")}
${chalk.blue(`${command.command} ${command.args.join(" ")}`)}`,
    `Installing ${
      (components as string[]).length
    } components with ${packageManager}`
  );

  const confirmInstall = await confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });

  if (isCancel(confirmInstall) || !confirmInstall) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  const saveAsPreset = await confirm({
    message: "Would you like to save this selection as a preset?",
    initialValue: false,
  });

  if (isCancel(saveAsPreset)) {
    outro(chalk.yellow("Cancelled"));
    process.exit(0);
  }

  try {
    await installComponents(components as string[]);

    if (saveAsPreset) {
      // TODO: save components to a config file
      console.log(chalk.green("Preset saved! (not really, yet)"));
    }

    outro(chalk.cyan("Done! Components have been installed successfully."));
  } catch (error) {
    outro(chalk.red("Installation failed. Please check the error above."));
    process.exit(1);
  }
}
