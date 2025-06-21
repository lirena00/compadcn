import { allComponents, type Component } from "./components.js";

function findComponents(values: string[]): Component[] {
  return values
    .map((value) => allComponents.find((comp) => comp.value === value))
    .filter((comp): comp is Component => comp !== undefined);
}

export interface Preset {
  label: string;
  description: string;
  components: Component[];
}

export interface PresetsData {
  presets: Record<string, Preset>;
}

export const presets: PresetsData = {
  presets: {
    core: {
      label: "Core Components",
      description: "Essential UI elements for any project",
      components: findComponents([
        "button",
        "input",
        "label",
        "card",
        "dialog",
        "separator",
      ]),
    },
    form: {
      label: "Form Components",
      description: "Form controls and validation components",
      components: findComponents([
        "form",
        "checkbox",
        "radio-group",
        "select",
        "switch",
        "textarea",
        "input-otp",
        "calendar",
        "slider",
      ]),
    },
    navigation: {
      label: "Navigation",
      description: "Navigation and menu components",
      components: findComponents([
        "breadcrumb",
        "dropdown-menu",
        "context-menu",
        "menubar",
        "navigation-menu",
        "pagination",
        "tabs",
      ]),
    },
    layout: {
      label: "Layout",
      description: "Layout and structure components",
      components: findComponents([
        "accordion",
        "collapsible",
        "resizable",
        "scroll-area",
        "sheet",
        "sidebar",
        "aspect-ratio",
      ]),
    },
    feedback: {
      label: "Feedback",
      description: "User feedback and notification components",
      components: findComponents([
        "alert",
        "alert-dialog",
        "sonner",
        "progress",
        "skeleton",
        "tooltip",
      ]),
    },
    dataDisplay: {
      label: "Data Display",
      description: "Tables, charts, and data visualization components",
      components: findComponents([
        "avatar",
        "badge",
        "table",
        "chart",
        "carousel",
      ]),
    },
    interactive: {
      label: "Interactive",
      description: "Advanced interactive elements",
      components: findComponents([
        "command",
        "hover-card",
        "popover",
        "toggle",
        "toggle-group",
        "drawer",
      ]),
    },
    mobile: {
      label: "Mobile First Components",
      description: "Components optimized for mobile experiences",
      components: findComponents([
        "button",
        "input",
        "sheet",
        "drawer",
        "sonner",
        "avatar",
        "badge",
        "card",
        "tabs",
        "scroll-area",
        "collapsible",
      ]),
    },
    dashboard: {
      label: "Dashboard Kit",
      description:
        "Perfect for building admin dashboards and data-heavy interfaces",
      components: findComponents([
        "card",
        "table",
        "chart",
        "badge",
        "avatar",
        "progress",
        "skeleton",
        "tabs",
        "select",
        "dropdown-menu",
        "sidebar",
        "breadcrumb",
        "pagination",
      ]),
    },
  },
};
