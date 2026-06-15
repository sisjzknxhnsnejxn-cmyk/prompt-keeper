# Prompt Keeper

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) plugin that saves and restores Prompt Manager entry states per chat session.

## Features

- **Per-Chat Configuration** — Each chat session remembers its own set of enabled/disabled prompt entries.
- **Auto-Save** — Prompt entry states are automatically saved when you toggle checkboxes.
- **Auto-Restore** — When switching chats, saved prompt configurations are automatically restored.
- **Multiple Restore Modes** — Choose between Auto Restore, Ask Before Restore, or Notify Only.
- **Integrated UI** — Save, Restore, and Delete buttons injected directly near the Prompt Manager area.
- **Status Display** — Visual indicator showing whether the current chat has a saved configuration.

## How It Works

When you enable or disable prompt entries in the Prompt Manager, Prompt Keeper automatically records the state of each entry tied to the current chat's unique ID. When you switch to a different chat, the plugin detects the `CHAT_CHANGED` event and restores the previously saved prompt configuration.

### Data Storage

All data is stored in SillyTavern's native `extension_settings.promptKeeper`:

```json
{
    "restoreMode": "auto",
    "configs": {
        "chatId_123": {
            "main": true,
            "jailbreak": true,
            "persona_description": false
        }
    }
}
```

## Installation

### Method 1: Via SillyTavern Extension Installer

1. Open SillyTavern
2. Go to **Extensions** panel → **Install Extension**
3. Paste the repository URL:
   ```
   https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
   ```
4. Click **Install**
5. Reload SillyTavern

### Method 2: Manual Installation

1. Navigate to your SillyTavern installation directory
2. Go to `data/<user-handle>/extensions/`
3. Clone this repository:
   ```bash
   git clone https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
   ```
4. Restart SillyTavern

## Usage

### Buttons (located near the Prompt Manager)

| Button | Action |
|--------|--------|
| 💾 **Save** | Immediately save the current prompt entry states for this chat |
| ↺ **Restore** | Manually restore the saved configuration for this chat |
| 🗑 **Delete** | Delete the saved configuration for this chat |

### Restore Modes (configurable in Extensions Settings)

| Mode | Behavior |
|------|----------|
| **Auto Restore** | Automatically applies saved config when switching chats |
| **Ask Before Restore** | Shows a confirmation dialog before restoring |
| **Notify Only** | Displays a notification that a saved config exists |

### Status Indicator

- `✓ Saved (Last: 2025-01-15 14:30)` — Configuration saved for this chat
- `⚠ Not Saved` — No saved configuration for this chat

## Scope

Prompt Keeper **only** manages Prompt Entry enabled/disabled states.

It does **NOT** manage:
- Model selection
- API settings
- Temperature / Top P
- Instruct Presets
- Context Templates
- Generation Settings

## Requirements

- SillyTavern 1.12.0 or later (with Prompt Manager support)

## Changelog

### v1.0.0

- Initial release
- Per-chat prompt entry state saving and restoration
- Three restore modes: auto, ask, notify
- Integrated UI with Save/Restore/Delete buttons
- Auto-save on prompt checkbox changes
- Status display with last save timestamp

## FAQ

**Q: Where is the data stored?**
A: In SillyTavern's native `extension_settings` under the key `promptKeeper`. It is saved alongside your other extension settings.

**Q: What happens if I delete a chat?**
A: The saved configuration for that chat remains in settings. You can manually clean it up, or it will simply be unused.

**Q: Does this affect other users or characters?**
A: No. Configurations are bound to chat IDs, not characters or users. Each unique chat session has its own independent configuration.

**Q: Will this conflict with other extensions?**
A: Prompt Keeper uses non-invasive DOM event delegation and does not modify SillyTavern core files. Conflicts are unlikely.

**Q: Can I disable auto-save?**
A: Auto-save is always active when prompt checkboxes change. You can use the manual Save button if you prefer explicit control, and choose "Notify Only" mode to prevent auto-restore.

## License

MIT License — see [LICENSE](LICENSE) for details.
