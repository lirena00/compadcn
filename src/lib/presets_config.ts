// Define types for better type safety
export interface Component {
  label: string;
  value: string;
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
      components: [
        { label: "Button", value: "button" },
        { label: "Input", value: "input" },
        { label: "Label", value: "label" },
        { label: "Card", value: "card" },
        { label: "Dialog", value: "dialog" },
        { label: "Separator", value: "separator" },
      ],
    },
    form: {
      label: "Form Components",
      description: "Form controls and validation components",
      components: [
        { label: "Checkbox", value: "checkbox" },
        { label: "Radio Group", value: "radio-group" },
        { label: "Select", value: "select" },
        { label: "Switch", value: "switch" },
        { label: "Textarea", value: "textarea" },
        { label: "Input OTP", value: "input-otp" },
        { label: "Calendar", value: "calendar" },
        { label: "Date Picker", value: "date-picker" },
        { label: "Slider", value: "slider" },
      ],
    },
    navigation: {
      label: "Navigation",
      description: "Navigation and menu components",
      components: [
        { label: "Breadcrumb", value: "breadcrumb" },
        { label: "Dropdown Menu", value: "dropdown-menu" },
        { label: "Context Menu", value: "context-menu" },
        { label: "Menubar", value: "menubar" },
        { label: "Navigation Menu", value: "navigation-menu" },
        { label: "Pagination", value: "pagination" },
        { label: "Tabs", value: "tabs" },
      ],
    },
    layout: {
      label: "Layout",
      description: "Layout and structure components",
      components: [
        { label: "Accordion", value: "accordion" },
        { label: "Collapsible", value: "collapsible" },
        { label: "Resizable", value: "resizable" },
        { label: "Scroll-area", value: "scroll-area" },
        { label: "Sheet", value: "sheet" },
        { label: "Sidebar", value: "sidebar" },
        { label: "Aspect Ratio", value: "aspect-ratio" },
      ],
    },
    feedback: {
      label: "Feedback",
      description: "User feedback and notification components",
      components: [
        { label: "Alert", value: "alert" },
        { label: "Alert Dialog", value: "alert-dialog" },
        { label: "Sonner", value: "sonner" },
        { label: "Progress", value: "progress" },
        { label: "Skeleton", value: "skeleton" },
        { label: "Tooltip", value: "tooltip" },
      ],
    },
    dataDisplay: {
      label: "Data Display",
      description: "Tables, charts, and data visualization components",
      components: [
        { label: "Avatar", value: "avatar" },
        { label: "Badge", value: "badge" },
        { label: "Table", value: "table" },
        { label: "Chart", value: "chart" },
        { label: "Carousel", value: "carousel" },
      ],
    },
    interactive: {
      label: "Interactive",
      description: "Advanced interactive elements",
      components: [
        { label: "Command", value: "command" },
        { label: "Combobox", value: "combobox" },
        { label: "Hover Card", value: "hover-card" },
        { label: "Popover", value: "popover" },
        { label: "Toggle", value: "toggle" },
        { label: "Toggle Group", value: "toggle-group" },
        { label: "Drawer", value: "drawer" },
      ],
    },
    mobile: {
      label: "Mobile First Components",
      description: "Components optimized for mobile experiences",
      components: [
        { label: "Button", value: "button" },
        { label: "Input", value: "input" },
        { label: "Sheet", value: "sheet" },
        { label: "Drawer", value: "drawer" },
        { label: "Sonner", value: "sonner" },
        { label: "Avatar", value: "avatar" },
        { label: "Badge", value: "badge" },
        { label: "Card", value: "card" },
        { label: "Tabs", value: "tabs" },
        { label: "Scroll-area", value: "scroll-area" },
        { label: "Collapsible", value: "collapsible" },
      ],
    },
    dashboard: {
      label: "Dashboard Kit",
      description:
        "Perfect for building admin dashboards and data-heavy interfaces",
      components: [
        { label: "Card", value: "card" },
        { label: "Table", value: "table" },
        { label: "Chart", value: "chart" },
        { label: "Badge", value: "badge" },
        { label: "Avatar", value: "avatar" },
        { label: "Progress", value: "progress" },
        { label: "Skeleton", value: "skeleton" },
        { label: "Tabs", value: "tabs" },
        { label: "Select", value: "select" },
        { label: "Date Picker", value: "date-picker" },
        { label: "Dropdown Menu", value: "dropdown-menu" },
        { label: "Sidebar", value: "sidebar" },
        { label: "Breadcrumb", value: "breadcrumb" },
        { label: "Pagination", value: "pagination" },
      ],
    },
  },
};
