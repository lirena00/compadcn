# compadcn

A powerful CLI tool for installing and managing ShadCN UI components with preset functionality.

## Features

- **Easy component installation** - Add ShadCN components with a single command
- **Smart linting** - Find and remove unused components from your project
- **Import cleanup** - Automatically removes imports when components are deleted
- **Dependency removal** - Optionally remove unused dependencies when components are deleted
- **Custom presets** - Create and save your own component collections

## Installation

```bash
npm install -g compadcn
# or
pnpm add -g compadcn
# or
yarn global add compadcn
```

## Commands

### `compadcn add [components...]`

Add ShadCN components to your project.

```bash
# Interactive mode - select components from a non installed components list
compadcn add

# Add specific components
compadcn add button card dialog
```

### `compadcn remove [components...]`

Remove ShadCN components from your project.

```bash
# Interactive mode - select installed components to remove
compadcn remove

# Remove specific components
compadcn remove button card
```

**Features:**

- Interactive removal with confirmation
- Dependency conflict detection
- Automatic import cleanup from your codebase
- Optional dependency removal
- Validates internal dependencies before removal

### `compadcn lint`

Find and remove unused ShadCN components from your project.

```bash
compadcn lint
```

**Features:**

- Scans your entire codebase for component usage
- Identifies unused components
- Option to automatically remove unused components
- Provides removal commands for manual cleanup

### `compadcn preset`

Manage component presets - collections of commonly used components.

```bash
# Interactive preset manager
compadcn preset
```

#### Preset Subcommands

```bash
# List all available presets
compadcn preset list
compadcn preset list --builtin    # Show only builtin presets
compadcn preset list --custom     # Show only custom presets

# Show components in a preset
compadcn preset show core
compadcn preset show "My Custom Preset"

# Install all components from a preset
compadcn preset install dashboard
compadcn preset install mobile

# Create a custom preset
compadcn preset create "my-preset" button card input
compadcn preset create "my-preset" --description "My custom components"
compadcn preset create "my-preset" --base core,form  # Extend multiple existing presets
compadcn preset create "dashboard-mobile" --base dashboard,mobile --description "Mobile dashboard components"

# Delete a custom preset
compadcn preset delete "my-preset"
```

## Requirements

- Node.js 18.0.0 or higher
- A ShadCN project with `components.json` file
- Package manager: npm, pnpm, yarn, or bun

## How It Works

1. **Component Detection**: Reads your `components.json` file to understand your project structure
2. **Package Manager Detection**: Automatically detects your package manager from lock files
3. **Smart Installation**: Uses the appropriate package manager to install components
4. **Usage Scanning**: Analyzes your codebase to find component usage patterns
5. **Dependency Management**: Handles both external and internal component dependencies

## File Structure

compadcn works with the standard ShadCN project structure:

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

Custom presets are stored in `~/.compadcn/custom-presets.json` and can be:

- Created from scratch
- Based on existing presets
- Shared across projects

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
