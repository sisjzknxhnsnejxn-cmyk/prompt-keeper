/**
 * Prompt Keeper - 常量与默认配置定义
 * 纯常量模块，不包含任何可变运行时状态。
 */

export const EXTENSION_NAME = 'prompt-keeper';
export const PLUGIN_VERSION = '2.2.3';
export const LOG_PREFIX = '[PromptKeeper]';
export const METADATA_KEY = 'promptKeeperState';
export const SETTINGS_KEY = 'promptKeeperPluginSettings';
export const SETTINGS_BACKUP_STORAGE_KEY = 'promptKeeper_settings_backup_v1';
export const SLOTS_BACKUP_STORAGE_KEY = 'promptKeeper_slots_backup_v2';
export const METADATA_VERSION = 2;
export const MAX_SLOTS_PER_CHAT = 5;
export const MAX_BACKUP_CHATS = 60;
export const MAX_GLOBAL_SLOTS = 20;
export const DEFAULT_AUTO_RESTORE_DELAY_MS = 1500;

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoRestore: true,
    customSaveName: false,
    autoRestoreDelay: DEFAULT_AUTO_RESTORE_DELAY_MS,
    slotPickerTheme: 'light',
});

export const AUTO_RESTORE_CONTEXT_TIMEOUT_MS = 3500;
export const AUTO_RESTORE_CONTEXT_POLL_MS = 100;
export const PRESET_SWITCH_TIMEOUT_MS = 3000;
export const PRESET_SWITCH_POLL_MS = 50;
export const PROMPT_STATE_READY_TIMEOUT_MS = 3000;
export const PROMPT_STATE_READY_POLL_MS = 50;
export const AUTO_RESTORE_MAX_RETRIES = 2;
export const AUTO_RESTORE_RETRY_DELAY_MS = 1800;

export const OBSERVER_REINJECTION_LIMIT = 10;
export const OBSERVER_REINJECTION_WINDOW = 30000;
export const UI_ENSURE_DELAYS_MS = Object.freeze([0, 300, 1000, 2000]);
export const PC_UI_WATCHDOG_INTERVAL_MS = 2500;

export const BUTTON_DEBOUNCE_MS = 400;
export const UI_REINJECT_SETTLE_MS = 600;
export const INTERACTION_DEBOUNCE_MS = 400;
export const TOUCH_MOVE_THRESHOLD_PX = 10;

export const PROMPT_KEEPER_BUTTON_SELECTOR = '#prompt-keeper-save, #prompt-keeper-restore, #prompt-keeper-delete';
export const ALL_BUTTON_EVENT_TYPES = Object.freeze(['pointerup', 'touchend', 'click']);

export const CHAT_COMPLETION_API_ID = 'openai';
