// ========== Prompt Keeper World Book Constants ==========

const WBK_LOG_PREFIX = '[PromptKeeper:WorldBook]';
const WBK_SETTINGS_KEY = 'promptKeeperWorldBookSettings';
const WBK_METADATA_KEY = 'promptKeeperWorldBookState';
const WBK_METADATA_VERSION = 1;
const WBK_MAX_SLOTS_PER_CHAT = 8;
const WBK_AUTO_RESTORE_DELAY_MS = 1800;
const WBK_BUTTON_DEBOUNCE_MS = 1000;
const WBK_INTERACTION_DEBOUNCE_MS = 450;
const WBK_ALL_BUTTON_EVENT_TYPES = ['pointerup', 'touchend', 'click'];
const WBK_UI_ENSURE_DELAYS_MS = [0, 350, 1200, 2500];
const WBK_SELECTED_BOOKS_RESTORE_MODES = ['merge', 'replace', 'skip'];

const WBK_DEFAULT_SETTINGS = {
    enabled: true,
    autoRestore: false,
    customSaveName: false,
    manageSelectedBooks: true,
    manageEntryStates: true,
    manageEntryOrder: true,
    captureAllKnownBooks: false,
    selectedBooksRestoreMode: 'merge',
    slotPickerTheme: 'light',
};

const WBK_SETTINGS_HTML = `
<div id="prompt-keeper-world-book-settings" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>Prompt Keeper · 世界书</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">
        <div class="settings_section">
            <label class="checkbox_label" for="wbk-enabled-toggle">
                <input type="checkbox" id="wbk-enabled-toggle" checked />
                <span>启用世界书保护</span>
            </label>
            <label class="checkbox_label" for="wbk-auto-restore-toggle">
                <input type="checkbox" id="wbk-auto-restore-toggle" />
                <span>切换聊天时自动恢复世界书</span>
            </label>
            <label class="checkbox_label" for="wbk-manage-selected-books-toggle">
                <input type="checkbox" id="wbk-manage-selected-books-toggle" checked />
                <span>保存/恢复已启用的世界书列表</span>
            </label>
            <label class="checkbox_label" for="wbk-manage-entry-states-toggle">
                <input type="checkbox" id="wbk-manage-entry-states-toggle" checked />
                <span>保存/恢复世界书条目蓝灯、绿灯和禁用状态</span>
            </label>
            <label class="checkbox_label" for="wbk-manage-entry-order-toggle">
                <input type="checkbox" id="wbk-manage-entry-order-toggle" checked />
                <span>保存/恢复世界书条目顺序</span>
            </label>
            <label class="checkbox_label" for="wbk-capture-all-known-books-toggle">
                <input type="checkbox" id="wbk-capture-all-known-books-toggle" />
                <span>保存全部已知世界书条目（默认仅保存当前启用世界书）</span>
            </label>
            <label for="wbk-selected-books-restore-mode">
                <span>恢复启用世界书列表</span>
                <select id="wbk-selected-books-restore-mode" class="text_pole">
                    <option value="merge">合并当前与保存列表（推荐）</option>
                    <option value="replace">严格替换为保存列表</option>
                    <option value="skip">不修改启用列表，只恢复条目</option>
                </select>
                <small class="notes">如果保存槽位与酒馆当前启用列表冲突，推荐使用合并；严格替换会覆盖当前列表。</small>
            </label>
            <label class="checkbox_label" for="wbk-custom-save-name-toggle">
                <input type="checkbox" id="wbk-custom-save-name-toggle" />
                <span>保存时允许自定义槽位名称</span>
            </label>
        </div>
        <details class="wbk-help-details">
            <summary>说明</summary>
            <div class="settings_section wbk-help-content">
                <label><strong>保存范围：</strong>默认保存当前聊天已启用的世界书列表，以及这些世界书里的条目开关；高级选项可保存全部已知世界书条目。</label>
                <label><strong>冲突处理：</strong>恢复时默认合并当前与保存的启用世界书列表，避免覆盖你在酒馆里临时启用的其它世界书。</label>
                <label><strong>条目状态：</strong>保护条目的禁用状态、蓝灯/选择性状态和绿灯/常驻状态。</label>
                <label><strong>条目顺序：</strong>默认保存并恢复世界书条目排序，适合需要固定优先级的世界书。</label>
            </div>
        </details>
    </div>
</div>`;

let wbkAutoRestoreTimer = null;
let wbkEventBindings = [];
let wbkEventHandlersBound = false;
let wbkAppReadyHandled = false;
let wbkLastHandledChatId = null;
let wbkJustSavedChatId = null;
let wbkSaveInProgress = false;
let wbkLastButtonActionById = {};
let wbkLastInteractionByKey = {};
let wbkUiEnsureTimers = [];
