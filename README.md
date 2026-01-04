# Alma Plugins

Official and example plugins for [Alma](https://github.com/yetone/alma).

## Plugin Types

Alma supports several types of plugins:

| Type | Description |
|------|-------------|
| `tool` | Registers tools that can be used by the AI assistant |
| `ui` | Adds UI components (status bar, sidebar, settings panels) |
| `theme` | Provides color themes for the application |
| `provider` | Adds new AI model providers |
| `transform` | Transforms messages, prompts, or responses |
| `integration` | Integrates with external services |
| `composite` | Combines multiple plugin types |

## Example Plugins

### Hello World (`plugins/hello-world`)

A simple tool plugin that demonstrates the basic structure of an Alma plugin.

**Features:**
- Registers a greeting tool that can be used by the AI
- Supports multiple languages (English, Chinese, Japanese, Spanish, French)
- Demonstrates command registration

**Type:** `tool`

### Token Counter (`plugins/token-counter`)

A UI plugin that displays token usage and estimated cost in the status bar.

**Features:**
- Real-time token count tracking
- Estimated cost calculation
- Configurable cost per million tokens
- Session-based statistics

**Type:** `ui`

### Catppuccin Theme (`plugins/catppuccin-theme`)

A theme plugin providing the beautiful Catppuccin color palette.

**Features:**
- Four flavors: Mocha, Macchiato, Frappé, and Latte
- Three dark themes and one light theme
- Configurable accent colors
- Based on the popular [Catppuccin](https://github.com/catppuccin/catppuccin) project

**Type:** `theme`

### Prompt Enhancer (`plugins/prompt-enhancer`)

A transform plugin that enhances prompts with additional context and instructions.

**Features:**
- Three enhancement modes: minimal, standard, detailed
- Optional timestamp injection
- Custom instructions support
- Toggle command for quick enable/disable

**Type:** `transform`

## Plugin Structure

Each plugin must have a `manifest.json` file and a main entry point:

```
my-plugin/
├── manifest.json    # Plugin metadata and configuration
├── main.ts          # Plugin entry point (TypeScript)
├── main.js          # Compiled JavaScript (for distribution)
└── README.md        # Plugin documentation (optional)
```

### manifest.json

```json
{
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "description": "A description of what the plugin does",
    "author": {
        "name": "Your Name",
        "email": "your@email.com"
    },
    "main": "main.js",
    "engines": {
        "alma": "^0.1.0"
    },
    "type": "tool",
    "permissions": ["notifications"],
    "activationEvents": ["onStartup"],
    "contributes": {
        "tools": [...],
        "commands": [...],
        "configuration": {...}
    }
}
```

### Plugin Entry Point

```typescript
import type { PluginContext, PluginActivation } from '@anthropic-ai/alma-plugin-api';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, tools, commands, hooks, ui, settings } = context;

    logger.info('Plugin activated!');

    // Register tools, commands, hooks, etc.

    return {
        dispose: () => {
            logger.info('Plugin deactivated');
            // Clean up resources
        },
    };
}
```

## Available APIs

### Context Properties

| Property | Description |
|----------|-------------|
| `logger` | Logging utilities (info, warn, error, debug) |
| `tools` | Register and manage AI tools |
| `commands` | Register command palette commands |
| `hooks` | Subscribe to lifecycle events |
| `ui` | UI utilities (notifications, status bar, dialogs) |
| `settings` | Read and write plugin settings |
| `storage` | Persistent key-value storage |
| `secrets` | Secure storage for sensitive data |
| `chat` | Access to chat threads and messages |
| `providers` | Access to AI providers |
| `workspace` | File system access (with permissions) |
| `i18n` | Internationalization utilities |

### Available Hooks

| Hook | Description |
|------|-------------|
| `chat.message.willSend` | Before a message is sent |
| `chat.message.didReceive` | After a response is received |
| `chat.system.transform` | Transform the system prompt |
| `chat.params.transform` | Transform model parameters |
| `tool.willExecute` | Before a tool is executed |
| `tool.didExecute` | After a tool completes |
| `tool.onError` | When a tool errors |
| `app.ready` | When the application starts |
| `app.willQuit` | Before the application quits |
| `thread.created` | When a new thread is created |
| `thread.deleted` | When a thread is deleted |

## Permissions

Plugins must declare required permissions in their manifest:

| Permission | Description |
|------------|-------------|
| `filesystem:read` | Read files from the filesystem |
| `filesystem:write` | Write files to the filesystem |
| `shell:execute` | Execute shell commands |
| `network:fetch` | Make network requests |
| `clipboard:read` | Read from clipboard |
| `clipboard:write` | Write to clipboard |
| `notifications` | Show system notifications |
| `chat:read` | Read chat messages |
| `chat:write` | Send chat messages |
| `settings:read` | Read application settings |
| `settings:write` | Modify application settings |
| `providers:manage` | Register custom providers |
| `tools:register` | Register AI tools |
| `ui:webview` | Create webview panels |

## Installation

### From Directory

1. Copy your plugin folder to the Alma plugins directory:
   - **macOS**: `~/Library/Application Support/Alma/plugins/`
   - **Windows**: `%APPDATA%/Alma/plugins/`
   - **Linux**: `~/.config/Alma/plugins/`

2. Restart Alma or use the "Refresh" button in Settings > Plugins

### From NPM (Coming Soon)

```bash
alma plugin install <package-name>
```

## Development

1. Create a new directory for your plugin
2. Create a `manifest.json` with your plugin metadata
3. Write your plugin code in TypeScript
4. Compile to JavaScript for distribution
5. Test by copying to the plugins directory

### TypeScript Setup

```bash
npm init -y
npm install -D typescript @anthropic-ai/alma-plugin-api
npx tsc --init
```

### Building

```bash
npx tsc
```

## License

MIT
