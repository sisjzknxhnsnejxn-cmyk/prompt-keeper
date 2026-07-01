/**
 * Prompt Keeper - SillyTavern Plugin
 * Saves and restores Prompt Manager entry states (enabled + order) AND the active preset per chat session.
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 3.0.0
 * @license MIT
 */

const EXTENSION_NAME = 'prompt-keeper';
const LOG_PREFIX = '[PromptKeeper]';
const METADATA_KEY = 'promptKeeperState';
const SETTINGS_KEY = 'promptKeeperPluginSettings';
const METADATA_VERSION = 2;
const MAX_SLOTS_PER_CHAT = 5;
const DEFAULT_AUTO_RESTORE_DELAY_MS = 1500;

const DEFAULT_SETTINGS = {
    enabled: true,
    autoRestore: true,
    customSaveName: false,
    autoRestoreDelay: 1500,
    slotPickerTheme: 'light',
};

const AUTO_RESTORE_CONTEXT_TIMEOUT_MS = 3500;
const AUTO_RESTORE_CONTEXT_POLL_MS = 100;
const PRESET_SWITCH_TIMEOUT_MS = 3000;
const PRESET_SWITCH_POLL_MS = 50;
const PROMPT_STATE_READY_TIMEOUT_MS = 3000;
const PROMPT_STATE_READY_POLL_MS = 50;
const AUTO_RESTORE_MAX_RETRIES = 2;
const AUTO_RESTORE_RETRY_DELAY_MS = 1800;

const SETTINGS_HTML = `
<div id="prompt-keeper-settings" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Prompt Keeper</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
        <div class="settings_section">
            <label class="checkbox_label" for="pk-enabled-toggle">
                <input type="checkbox" id="pk-enabled-toggle" checked />
                <span>启用插件</span>
            </label>
            <label class="checkbox_label" for="pk-auto-restore-toggle">
                <input type="checkbox" id="pk-auto-restore-toggle" checked />
                <span>切换聊天时自动恢复</span>
            </label>
            <label class="checkbox_label" for="pk-custom-save-name-toggle">
                <input type="checkbox" id="pk-custom-save-name-toggle" />
                <span>保存时允许自定义名称</span>
            </label>
        </div>
        <details class="pk-help-details">
            <summary>使用说明</summary>
            <div class="settings_section pk-help-content">
                <label><strong>保存方式：</strong> 手动点击保存按钮</label>
                <label><strong>恢复方式：</strong> 自动（切换聊天时延迟恢复）或手动</label>
                <label><strong>保存位置：</strong> 当前聊天的元数据中</label>
                <label><strong>自定义名称：</strong> 开启后，同一预设可保存多个不同槽位</label>
            </div>
        </details>
    </div>
</div>`;

// ========== State ==========

let autoRestoreTimer = null;
let autoRestoreRetryCountByChatId = {};

/** 上一次处理的 chatId，避免同一聊天内重复触发恢复 */
let lastHandledChatId = null;

/** 保存后保护标记，防止自动恢复立刻切回旧预设 */
let justSavedChatId = null;

let uiObserver = null;
let observerThrottleTimer = null;
let observerPaused = false;
let dragListenersBound = false;
let observerRafId = null;

let observerReinjectionCount = 0;
let observerReinjectionResetTimer = null;
const OBSERVER_REINJECTION_LIMIT = 10;
const OBSERVER_REINJECTION_WINDOW = 30000;
const UI_ENSURE_DELAYS_MS = [0, 300, 1000, 2000];
const PC_UI_WATCHDOG_INTERVAL_MS = 2500;
let uiEnsureTimers = [];
let pcUIWatchdogTimer = null;

let lastButtonActionById = {};
let uiInjectInProgress = false;
let lastUIInjectAt = 0;
let statusDisplayRafId = null;
let pendingStatusDisplay = null;
let lastStatusDisplaySignature = '';
let promptKeeperButtonDelegationBound = false;
let promptKeeperButtonDelegatedEvents = '';
const BUTTON_DEBOUNCE_MS = 1200;
const UI_REINJECT_SETTLE_MS = 900;
const PROMPT_KEEPER_BUTTON_SELECTOR = '#prompt-keeper-save, #prompt-keeper-restore, #prompt-keeper-delete';
const ALL_BUTTON_EVENT_TYPES = ['pointerup', 'touchend', 'click'];
const INTERACTION_DEBOUNCE_MS = 450;
let saveInProgress = false;
let migratedStatePersistTimer = null;
let migratedStatePersistIdleId = null;

let promptKeeperEventHandlersBound = false;
let promptKeeperAppReadyHandled = false;
let promptKeeperRefreshingUI = false;
let promptKeeperEventBindings = [];
