/**
 * Prompt Keeper (预设条目状态保持器) — SillyTavern Extension Entry
 *
 * 采用原生 ES Modules 架构，按单一职责拆分到 src/ 各子模块：
 * - src/config/constants.js             常量与默认配置
 * - src/config/runtime-state.js         集中式可变运行时状态与销毁清理
 * - src/utils/st-context.js             SillyTavern 上下文与弹窗接口封装
 * - src/utils/format.js                 时间格式化、安全属性检查与名称规范化
 * - src/utils/dom-events.js             移动端触控防重与交互辅助
 * - src/core/settings.js                插件设置读写与校验
 * - src/core/state-migration.js         聊天元数据版本迁移与槽位查询
 * - src/core/prompt-reader.js           Prompt 条目开关与排序读取（API + DOM 回退）
 * - src/core/prompt-dirty-check.js      脏检查与顺序一致性对比算法
 * - src/core/prompt-applier.js          Prompt 状态与排序智能合并写回
 * - src/services/preset-service.js      预设读取、切换与 UI 稳定刷新
 * - src/services/slot-service.js        槽位保存、恢复、删除与默认槽位管理
 * - src/services/auto-restore-service.js 聊天切换自动恢复与重试调度
 * - src/ui/templates.js                 工具栏与设置面板 HTML 模板
 * - src/ui/status-bar.js                工具栏状态指示器渲染
 * - src/ui/slot-picker-modal.js         多槽位管理与恢复模态弹窗
 * - src/ui/settings-panel.js            扩展设置面板注入与事件绑定
 * - src/ui/ui-observer.js               工具栏注入、事件委托与 MutationObserver 保活
 * - src/app.js                          插件生命周期控制（初始化、事件绑定与热重载销毁）
 */

import { destroyPromptKeeper, initPromptKeeper } from './src/app.js';
import { LOG_PREFIX, PLUGIN_VERSION } from './src/config/constants.js';
import { applyPromptStates } from './src/core/prompt-applier.js';
import { checkDirtyState, promptOrderEqual } from './src/core/prompt-dirty-check.js';
import { readPromptStates } from './src/core/prompt-reader.js';
import {
    isAutoRestoreEnabled,
    isPluginEnabled,
    loadPluginSettings,
    savePluginSettings,
} from './src/core/settings.js';
import {
    findSlotName,
    getBestRestoreSlotName,
    getDefaultSlotName,
    getDefaultSlotState,
    getSavedStateFromCurrentChat,
    getSlotEntries,
    migrateState,
} from './src/core/state-migration.js';
import { onChatChanged } from './src/services/auto-restore-service.js';
import {
    getCurrentPresetName,
    refreshPromptManagerUI,
    switchToPreset,
} from './src/services/preset-service.js';
import {
    deleteSavedStates,
    hasSavedState,
    restoreStatesFromMetadata,
    saveStatesToMetadata,
    setDefaultSlot,
} from './src/services/slot-service.js';
import { injectSettingsPanel } from './src/ui/settings-panel.js';
import { closeSlotPickerModal, openSlotPickerModal } from './src/ui/slot-picker-modal.js';
import { updateStatusDisplay } from './src/ui/status-bar.js';
import { injectUI, scheduleEnsurePromptKeeperUI } from './src/ui/ui-observer.js';

/**
 * 启动或热重载插件实例
 */
function bootstrapPromptKeeper() {
    try {
        if (
            typeof window !== 'undefined' &&
            window.PromptKeeper &&
            typeof window.PromptKeeper.destroy === 'function'
        ) {
            window.PromptKeeper.destroy();
        }

        if (typeof window !== 'undefined') {
            window.PromptKeeper = {
                version: PLUGIN_VERSION,
                init: initPromptKeeper,
                destroy: destroyPromptKeeper,
                reload: bootstrapPromptKeeper,
                saveStatesToMetadata,
                restoreStatesFromMetadata,
                deleteSavedStates,
                setDefaultSlot,
                hasSavedState,
                readPromptStates,
                applyPromptStates,
                checkDirtyState,
                promptOrderEqual,
                migrateState,
                getSlotEntries,
                findSlotName,
                getDefaultSlotState,
                getDefaultSlotName,
                getBestRestoreSlotName,
                getSavedStateFromCurrentChat,
                getCurrentPresetName,
                switchToPreset,
                refreshPromptManagerUI,
                loadPluginSettings,
                savePluginSettings,
                isPluginEnabled,
                isAutoRestoreEnabled,
                updateStatusDisplay,
                openSlotPickerModal,
                closeSlotPickerModal,
                injectUI,
                injectSettingsPanel,
                scheduleEnsurePromptKeeperUI,
                onChatChanged,
            };
            window.PromptKeeperReload = bootstrapPromptKeeper;
        }

        initPromptKeeper(0);
    } catch (error) {
        console.error(LOG_PREFIX, 'Failed to initialize Prompt Keeper:', error);
    }
}

if (typeof window !== 'undefined') {
    bootstrapPromptKeeper();
}

export { bootstrapPromptKeeper, initPromptKeeper, destroyPromptKeeper };
