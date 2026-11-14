/**
 * Prompt Keeper - UI HTML 模板构建器
 */

/**
 * 构建 Prompt Manager 工具栏 HTML
 */
export function buildPromptKeeperBarHTML() {
    return `
<div id="prompt-keeper-bar" class="prompt-keeper-bar">
    <div class="prompt-keeper-header">
        <span class="prompt-keeper-title">
            <i class="fa-solid fa-bookmark"></i>
            <span>预设状态</span>
        </span>
        <span id="prompt-keeper-status" class="prompt-keeper-status pk-not-saved not-saved">未保存</span>
    </div>
    <div class="prompt-keeper-btn-group prompt-keeper-actions">
        <button id="prompt-keeper-save" type="button" class="prompt-keeper-btn pk-bar-btn pk-bar-btn-primary" title="保存">
            <i class="fa-solid fa-floppy-disk"></i>
            <span>保存</span>
        </button>
        <button id="prompt-keeper-restore" type="button" class="prompt-keeper-btn pk-bar-btn" title="恢复">
            <i class="fa-solid fa-rotate-left"></i>
            <span>恢复</span>
        </button>
        <button id="prompt-keeper-delete" type="button" class="prompt-keeper-btn pk-bar-btn prompt-keeper-btn-danger" title="删除" style="display:none;">
            <i class="fa-solid fa-trash-can"></i>
            <span>删除</span>
        </button>
    </div>
</div>`;
}

/**
 * 构建扩展设置面板 HTML
 * 根元素直接作为 .inline-drawer 挂载在 #extensions_settings2 下，
 * 无冗余解释性文字，配色切换已移至弹窗右上角日/夜间按钮（默认日间）。
 */
export function buildSettingsPanelHTML(settings) {
    return `
<div id="prompt-keeper-settings" class="inline-drawer prompt-keeper-settings">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b><i class="fa-solid fa-bookmark" style="margin-right:6px;"></i>Prompt Keeper</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <div class="pk-setting-row">
            <label class="checkbox_label" for="pk-setting-enabled">
                <input id="pk-setting-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                <span>启用插件</span>
            </label>
        </div>
        <div class="pk-setting-row">
            <label class="checkbox_label" for="pk-setting-auto-restore">
                <input id="pk-setting-auto-restore" type="checkbox" ${settings.autoRestore ? 'checked' : ''} />
                <span>切换聊天时自动恢复</span>
            </label>
        </div>
        <div class="pk-setting-row">
            <label class="checkbox_label" for="pk-setting-custom-save-name">
                <input id="pk-setting-custom-save-name" type="checkbox" ${settings.customSaveName ? 'checked' : ''} />
                <span>保存时自定义槽位名称</span>
            </label>
        </div>
        <div class="pk-setting-row">
            <label class="checkbox_label" for="pk-setting-prevent-pull-refresh">
                <input id="pk-setting-prevent-pull-refresh" type="checkbox" ${settings.preventPullToRefresh !== false ? 'checked' : ''} />
                <span>防止手机端下拉误触刷新页面</span>
            </label>
        </div>
        <div class="pk-setting-row">
            <label class="checkbox_label" for="pk-setting-confirm-unload">
                <input id="pk-setting-confirm-unload" type="checkbox" ${settings.confirmBeforeUnload ? 'checked' : ''} />
                <span>刷新或关闭页面前弹出确认拦截</span>
            </label>
        </div>
        <div class="pk-setting-row pk-setting-row-inline">
            <label for="pk-setting-delay">自动恢复延迟 (ms)</label>
            <input id="pk-setting-delay" type="number" class="text_pole" min="300" max="5000" step="100" value="${settings.autoRestoreDelay}" style="width:92px;" />
        </div>
    </div>
</div>`;
}
