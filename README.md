# shadcn-plus

A CLI for installing and managing shadcn/ui components and presets, formerly named compadcn.

V2 is under development. This checkout retains the existing component and preset commands while its new foundations are implemented. Multi-registry auditing and cleanup plans are not implemented yet.

## Features

- **Easy component installation** - Add ShadCN components with a single command
- **Smart linting** - Find and remove unused components from your project
- **Import cleanup** - Automatically removes imports when components are deleted
- **Dependency removal** - Optionally remove unused dependencies when components are deleted
- **Custom presets** - Create and save your own component collections

## Local development

```bash
pnpm install --frozen-lockfile
pnpm run build
node dist/cli.js --help
```

## Installation

Once the renamed package is published:

```bash
npm install -g shadcn-plus
# or
pnpm add -g shadcn-plus
# or
yarn global add shadcn-plus
```

## Commands

### `shadcn-plus add [components...]`

Add ShadCN components to your project.

```bash
# Interactive mode - select components from a non installed components list
shadcn-plus add

# Add specific components
shadcn-plus add button card dialog
```

### `shadcn-plus remove [components...]`

Remove ShadCN components from your project.

```bash
# Interactive mode - select installed components to remove
shadcn-plus remove

# Remove specific components
shadcn-plus remove button card
```

**Features:**

- Interactive removal with confirmation
- Dependency conflict detection
- Automatic import cleanup from your codebase
- Optional dependency removal
- Validates internal dependencies before removal

### `shadcn-plus lint`

Find and remove unused ShadCN components from your project.

```bash
shadcn-plus lint
```

**Features:**

- Scans your entire codebase for component usage
- Identifies unused components
- Option to automatically remove unused components
- Provides removal commands for manual cleanup

### `shadcn-plus preset`

Manage component presets - collections of commonly used components.

```bash
# Interactive preset manager
shadcn-plus preset
```

#### Preset Subcommands

```bash
# List all available presets
shadcn-plus preset list
shadcn-plus preset list --builtin    # Show only builtin presets
shadcn-plus preset list --custom     # Show only custom presets

# Show components in a preset
shadcn-plus preset show core
shadcn-plus preset show "My Custom Preset"

# Install all components from a preset
shadcn-plus preset install dashboard
shadcn-plus preset install mobile

# Create a custom preset
shadcn-plus preset create "my-preset" button card input
shadcn-plus preset create "my-preset" --description "My custom components"
shadcn-plus preset create "my-preset" --base core,form  # Extend multiple existing presets
shadcn-plus preset create "dashboard-mobile" --base dashboard,mobile --description "Mobile dashboard components"

# Delete a custom preset
shadcn-plus preset delete "my-preset"
```

## Requirements

- Node.js 22.12.0 or higher
- A ShadCN project with `components.json` file
- Package manager: npm, pnpm, yarn, or bun

## How It Works

1. **Component Detection**: Reads your `components.json` file to understand your project structure
2. **Package Manager Detection**: Automatically detects your package manager from lock files
3. **Smart Installation**: Uses the appropriate package manager to install components
4. **Usage Scanning**: Analyzes your codebase to find component usage patterns
5. **Dependency Management**: Handles both external and internal component dependencies

## File Structure

shadcn-plus works with the standard ShadCN project structure:

```
your-project/
├── components.json          # ShadCN configuration
├── src/
│   └── components/
│       └── ui/             # Components directory
│           ├── button.tsx
│           ├── card.tsx
│           └── ...
└── package.json
```

## Custom Presets

Custom presets continue to use the existing `~/.compadcn/custom-presets.json` storage until an explicit migration is implemented and can be:

- Created from scratch
- Based on existing presets
- Shared across projects

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request
