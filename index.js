/**
 * Prompt Keeper - SillyTavern Extension
 *
 * 为每个聊天会话（Chat Session）保存和恢复 Prompt Manager 中 Prompt Entry 的开关状态。
 * 配置数据存储在聊天元数据（Chat Metadata）中，随聊天记录一起保存。
 *
 * 架构原则：
 * - Prompt State Adapter：所有 Prompt Entry 的读写必须经过 Adapter
 * - Feature Detection：运行时检测可用 API，不依赖版本号
 * - 优先级：官方 API > 内部数据模型 > 事件系统 > DOM（最后兜底）
 * - 不假设 Prompt Manager 实现、CSS 类名、DOM 结构、对象路径
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.0.0
 * @license MIT
 * @homepage https://github.com/sisjzknxhnsnejxn-cmyk/prompt-keeper
 */

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

// ============================================================
// 常量定义
// ============================================================

/** 模块名称，用于设置存储和聊天元数据的 key */
const MODULE_NAME = 'prompt_keeper';

/** 日志前缀 */
const LOG_PREFIX = '[PromptKeeper]';

/** 默认插件设置 */
const DEFAULT_SETTINGS = {
    /** 恢复模式: 'auto' 自动恢复 | 'ask' 询问恢复 | 'notify' 仅提示 */
    restoreMode: 'auto',
    /** 是否启用插件 */
    enabled: true,
};

/** Adapter 检测策略的缓存有效期（毫秒） */
const STRATEGY_CACHE_TTL = 5000;

// ============================================================
// Prompt State Adapter
// ============================================================

/**
 * Prompt State Adapter
 *
 * 所有 Prompt Entry 状态的读取和写入必须经过此 Adapter。
 * Adapter 内部负责：
 *   1. 检测当前 ST 实现
 *   2. 检测 Prompt Manager 数据来源
 *   3. 选择正确实现
 *
 * 插件其他部分不得直接访问 Prompt Manager。
 */
const PromptStateAdapter = (() => {
    /** 策略缓存 */
    let _cachedStrategy = null;
    let _cacheTimestamp = 0;

    /**
     * 标准化的 prompt state 条目
     * @typedef {Object} PromptStateEntry
     * @property {string} identifier - prompt entry 的唯一标识符
     * @property {boolean} enabled - 是否启用
     */

    // --------------------------------------------------------
    // 策略检测
    // --------------------------------------------------------

    /**
     * 检测当前可用的最佳策略
     * 使用 Feature Detection，按优先级检测
     * @returns {string} 策略名称
     */
    function detectStrategy() {
        const now = Date.now();
        if (_cachedStrategy && (now - _cacheTimestamp) < STRATEGY_CACHE_TTL) {
            return _cachedStrategy;
        }

        const strategy = _detectStrategyInternal();
        _cachedStrategy = strategy;
        _cacheTimestamp = now;

        console.log(`${LOG_PREFIX} [Adapter] Detected strategy: ${strategy}`);
        return strategy;
    }

    /**
     * 内部策略检测逻辑
     * @returns {string}
     */
    function _detectStrategyInternal() {
        // 策略 1: 官方 PromptManager API（通过 context 暴露）
        if (_hasPromptManagerAPI()) {
            return 'promptManagerAPI';
        }

        // 策略 2: 通过 ST 事件系统获取 prompt order 数据
        if (_hasPromptOrderData()) {
            return 'promptOrderData';
        }

        // 策略 3: DOM 兜底（最后手段）
        if (_hasDOMAccess()) {
            return 'dom';
        }

        return 'unavailable';
    }

    /**
     * 检测是否有 PromptManager API 可用
     * 不假设具体方法名，而是动态检测
     */
    function _hasPromptManagerAPI() {
        try {
            const context = getContext();
            if (!context) return false;

            // 检测 context 上是否暴露了能获取 PromptManager 实例的方法
            const pmGetter = _findPromptManagerGetter(context);
            if (!pmGetter) return false;

            const pm = pmGetter();
            if (!pm) return false;

            // 检测 PM 实例是否有获取 prompt order 的能力
            const orderGetter = _findOrderGetter(pm);
            if (!orderGetter) return false;

            const order = orderGetter();
            return Array.isArray(order) && order.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * 检测是否有 prompt order 数据可从全局获取
     */
    function _hasPromptOrderData() {
        try {
            const orderData = _findPromptOrderFromGlobals();
            return orderData !== null && Array.isArray(orderData) && orderData.length > 0;
        } catch (e) {
            return false;
        }
    }

    /**
     * 检测是否有 DOM 可访问（作为最后兜底）
     */
    function _hasDOMAccess() {
        try {
            // 不假设具体 ID 或 class，而是搜索可能的 prompt manager 列表容器
            const container = _findPromptManagerContainer();
            if (!container) return false;

            const items = _findPromptItems(container);
            return items && items.length > 0;
        } catch (e) {
            return false;
        }
    }

    // --------------------------------------------------------
    // Feature Detection 辅助函数
    // --------------------------------------------------------

    /**
     * 在 context 对象上查找能返回 PromptManager 实例的方法
     * 不假设方法名，通过特征检测
     */
    function _findPromptManagerGetter(context) {
        // 按可能性从高到低检测
        const candidateNames = [
            'getPromptManager',
            'promptManager',
            'getPromptManagerInstance',
        ];

        for (const name of candidateNames) {
            if (typeof context[name] === 'function') {
                return () => context[name]();
            }
            // 也可能是属性而非方法
            if (context[name] && typeof context[name] === 'object') {
                return () => context[name];
            }
        }

        // 遍历 context 属性，寻找可能是 PromptManager 的对象
        for (const key of Object.keys(context)) {
            const val = context[key];
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                // 检测是否具有 prompt manager 特征（有获取 order 的能力）
                if (_findOrderGetter(val)) {
                    return () => val;
                }
            }
        }

        return null;
    }

    /**
     * 在 PromptManager 实例上查找获取 prompt order 的方法
     */
    function _findOrderGetter(pm) {
        const candidateNames = [
            'getPromptOrder',
            'getOrderedPrompts',
            'getCompletionPromptOrder',
            'promptOrder',
            'serviceSettings',
        ];

        for (const name of candidateNames) {
            if (typeof pm[name] === 'function') {
                try {
                    const result = pm[name]();
                    if (Array.isArray(result)) {
                        return () => pm[name]();
                    }
                    // serviceSettings 可能返回一个包含 prompt_order 的对象
                    if (result && typeof result === 'object') {
                        const order = _extractOrderFromObject(result);
                        if (order) return () => _extractOrderFromObject(pm[name]());
                    }
                } catch (e) {
                    // 调用失败，跳过
                }
            }
            if (Array.isArray(pm[name])) {
                return () => pm[name];
            }
        }

        return null;
    }

    /**
     * 从对象中提取 prompt order 数组
     * 适配不同数据结构
     */
    function _extractOrderFromObject(obj) {
        if (!obj || typeof obj !== 'object') return null;

        // 直接是数组
        if (Array.isArray(obj)) return obj;

        // 可能在 .order 或 .prompt_order 下
        const candidateKeys = ['order', 'prompt_order', 'prompts', 'entries'];
        for (const key of candidateKeys) {
            if (Array.isArray(obj[key]) && obj[key].length > 0) {
                // 验证数组元素是否像 prompt order entry
                if (_looksLikePromptOrder(obj[key])) {
                    return obj[key];
                }
            }
        }

        return null;
    }

    /**
     * 检查数组是否看起来像 prompt order 数据
     */
    function _looksLikePromptOrder(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        const sample = arr[0];
        if (!sample || typeof sample !== 'object') return false;
        // prompt order entry 通常有 identifier 字段
        return ('identifier' in sample) || ('name' in sample && 'enabled' in sample);
    }

    /**
     * 从全局对象中查找 prompt order 数据
     * 使用 Feature Detection 而不是假设固定路径
     */
    function _findPromptOrderFromGlobals() {
        const context = getContext();

        // 检查 window 上可能的全局设置对象
        const globalCandidates = [
            // 不假设特定名称，按特征检测
            () => _searchWindowForPromptOrder(),
        ];

        for (const getter of globalCandidates) {
            try {
                const result = getter();
                if (result) return result;
            } catch (e) {
                // continue
            }
        }

        return null;
    }

    /**
     * 搜索 window 上可能包含 prompt_order 的对象
     */
    function _searchWindowForPromptOrder() {
        // 检查常见的全局设置对象名称模式
        const settingsNames = Object.keys(window).filter(key => {
            return key.includes('settings') || key.includes('Settings');
        });

        for (const name of settingsNames) {
            try {
                const obj = window[name];
                if (!obj || typeof obj !== 'object') continue;

                // 查找 prompt_order 属性
                if (Array.isArray(obj.prompt_order)) {
                    const resolved = _resolvePromptOrderArray(obj.prompt_order);
                    if (resolved) return resolved;
                }
            } catch (e) {
                // continue
            }
        }

        return null;
    }

    /**
     * 从 prompt_order 数组中解析出当前适用的 order entries
     * prompt_order 格式可能是：
     *   [{character_id, order: [{identifier, enabled}]}]
     *   或直接是 [{identifier, enabled}]
     */
    function _resolvePromptOrderArray(promptOrder) {
        if (!Array.isArray(promptOrder) || promptOrder.length === 0) return null;

        // 检查是否是直接的 order entries 数组
        if (_looksLikePromptOrder(promptOrder)) {
            return promptOrder;
        }

        // 可能是按角色分组的结构
        const context = getContext();
        const charId = context?.characterId;

        // 尝试找到匹配当前角色的条目
        let entry = null;

        for (const item of promptOrder) {
            if (!item || typeof item !== 'object') continue;

            // 查找匹配当前角色的
            if (charId !== undefined && item.character_id === charId) {
                entry = item;
                break;
            }
        }

        // 如果没找到角色特定的，用默认的
        if (!entry) {
            entry = promptOrder.find(item =>
                item && typeof item === 'object' &&
                (item.character_id == null || item.character_id === 'default')
            );
        }

        // 如果还没有，用第一个有效的
        if (!entry && promptOrder.length > 0) {
            entry = promptOrder[0];
        }

        if (!entry) return null;

        // 从 entry 中提取 order 数组
        const order = _extractOrderFromObject(entry);
        return order;
    }

    // --------------------------------------------------------
    // DOM 相关辅助（最后兜底）
    // --------------------------------------------------------

    /**
     * 查找 Prompt Manager 容器元素
     * 不假设固定 ID，通过多种特征检测
     */
    function _findPromptManagerContainer() {
        // 尝试多种可能的容器选择策略
        const selectors = [
            // 通过 data 属性
            '[data-prompt-manager]',
            '[data-pm-list]',
            // 通过 role 属性
            '[role="prompt-manager-list"]',
        ];

        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) return el;
        }

        // 通过 ID 模式匹配（不假设完整 ID）
        const allElements = document.querySelectorAll('[id]');
        for (const el of allElements) {
            const id = el.id.toLowerCase();
            if (id.includes('prompt') && id.includes('manager') && id.includes('list')) {
                return el;
            }
        }

        // 通过内容特征检测：查找包含多个可切换条目的列表容器
        // 检测条件：容器内有多个子元素，每个子元素有 identifier 相关属性
        const candidates = document.querySelectorAll('[id*="prompt"], [class*="prompt"]');
        for (const el of candidates) {
            const items = el.querySelectorAll('[data-pm-identifier], [data-identifier], [data-prompt-id]');
            if (items.length > 0) return el;
        }

        return null;
    }

    /**
     * 在容器中查找 prompt 条目元素
     */
    function _findPromptItems(container) {
        if (!container) return [];

        // 通过 data 属性查找带 identifier 的元素
        const attrCandidates = [
            'data-pm-identifier',
            'data-identifier',
            'data-prompt-id',
            'data-id',
        ];

        for (const attr of attrCandidates) {
            const items = container.querySelectorAll(`[${attr}]`);
            if (items.length > 0) {
                return { items, identifierAttr: attr };
            }
        }

        return null;
    }

    /**
     * 从 DOM 元素中检测 enabled 状态
     */
    function _detectEnabledState(element) {
        // 策略 1: 查找 checkbox/toggle input
        const inputs = element.querySelectorAll('input[type="checkbox"]');
        for (const input of inputs) {
            // 检查是否是 toggle 类的 input（而不是其他用途）
            const parent = input.closest('[class*="toggle"], [class*="switch"], [role="switch"]');
            if (parent || inputs.length === 1) {
                return input.checked;
            }
        }

        // 如果只有一个 checkbox，就用它
        if (inputs.length === 1) {
            return inputs[0].checked;
        }

        // 策略 2: 检查 data 属性
        const enabledAttr = element.getAttribute('data-enabled') ??
                           element.getAttribute('data-pm-enabled') ??
                           element.getAttribute('data-active');
        if (enabledAttr !== null) {
            return enabledAttr === 'true' || enabledAttr === '1';
        }

        // 策略 3: 检查元素类名是否包含 disabled/inactive 关键词
        const classList = element.className.toLowerCase();
        if (classList.includes('disabled') || classList.includes('inactive') || classList.includes('off')) {
            return false;
        }

        // 默认认为启用
        return true;
    }

    /**
     * 在 DOM 中设置 prompt entry 的 enabled 状态
     */
    function _setDOMEnabledState(element, shouldBeEnabled) {
        // 策略 1: 操作 checkbox
        const inputs = element.querySelectorAll('input[type="checkbox"]');
        let toggled = false;

        for (const input of inputs) {
            const parent = input.closest('[class*="toggle"], [class*="switch"], [role="switch"]');
            if (parent || inputs.length === 1) {
                if (input.checked !== shouldBeEnabled) {
                    input.checked = shouldBeEnabled;
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    toggled = true;
                }
                break;
            }
        }

        if (!toggled && inputs.length === 1) {
            const input = inputs[0];
            if (input.checked !== shouldBeEnabled) {
                input.checked = shouldBeEnabled;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                toggled = true;
            }
        }

        // 策略 2: 如果没有 checkbox，尝试 click toggle 按钮
        if (!toggled) {
            const currentState = _detectEnabledState(element);
            if (currentState !== shouldBeEnabled) {
                // 查找可点击的 toggle 元素
                const toggleEl = element.querySelector(
                    '[class*="toggle"], [role="switch"], button[class*="toggle"]'
                );
                if (toggleEl) {
                    toggleEl.click();
                    toggled = true;
                }
            }
        }

        return toggled;
    }

    // --------------------------------------------------------
    // 公开 API: getPromptStates / setPromptStates
    // --------------------------------------------------------

    /**
     * 获取当前所有 Prompt Entry 的状态
     * @returns {PromptStateEntry[]|null} 状态数组或 null
     */
    function getPromptStates() {
        const strategy = detectStrategy();

        switch (strategy) {
            case 'promptManagerAPI':
                return _getStatesViaAPI();
            case 'promptOrderData':
                return _getStatesViaData();
            case 'dom':
                return _getStatesViaDOM();
            default:
                console.warn(`${LOG_PREFIX} [Adapter] No available strategy to read prompt states`);
                return null;
        }
    }

    /**
     * 设置 Prompt Entry 的状态
     * @param {PromptStateEntry[]} states - 要设置的状态数组
     * @returns {boolean} 是否成功
     */
    function setPromptStates(states) {
        if (!states || !Array.isArray(states) || states.length === 0) return false;

        const strategy = detectStrategy();

        switch (strategy) {
            case 'promptManagerAPI':
                return _setStatesViaAPI(states);
            case 'promptOrderData':
                return _setStatesViaData(states);
            case 'dom':
                return _setStatesViaDOM(states);
            default:
                console.warn(`${LOG_PREFIX} [Adapter] No available strategy to set prompt states`);
                return false;
        }
    }

    /**
     * 强制刷新策略缓存
     */
    function invalidateCache() {
        _cachedStrategy = null;
        _cacheTimestamp = 0;
    }

    /**
     * 获取当前检测到的策略名称（用于调试）
     */
    function getCurrentStrategy() {
        return detectStrategy();
    }

    // --------------------------------------------------------
    // 策略实现: PromptManager API
    // --------------------------------------------------------

    function _getStatesViaAPI() {
        try {
            const context = getContext();
            const pmGetter = _findPromptManagerGetter(context);
            if (!pmGetter) return null;

            const pm = pmGetter();
            if (!pm) return null;

            const orderGetter = _findOrderGetter(pm);
            if (!orderGetter) return null;

            const order = orderGetter();
            if (!Array.isArray(order)) return null;

            return _normalizeOrderToStates(order);
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error in API strategy:`, e);
            return null;
        }
    }

    function _setStatesViaAPI(states) {
        try {
            const context = getContext();
            const pmGetter = _findPromptManagerGetter(context);
            if (!pmGetter) return false;

            const pm = pmGetter();
            if (!pm) return false;

            const orderGetter = _findOrderGetter(pm);
            if (!orderGetter) return false;

            const order = orderGetter();
            if (!Array.isArray(order)) return false;

            let changed = false;
            const stateMap = new Map(states.map(s => [s.identifier, s.enabled]));

            for (const item of order) {
                const id = item.identifier ?? item.name ?? item.id;
                if (!id || !stateMap.has(id)) continue;

                const shouldBeEnabled = stateMap.get(id);
                if ('enabled' in item && item.enabled !== shouldBeEnabled) {
                    item.enabled = shouldBeEnabled;
                    changed = true;
                }
            }

            if (changed) {
                _triggerPMUpdate(pm);
            }

            return true;
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error setting states via API:`, e);
            return false;
        }
    }

    // --------------------------------------------------------
    // 策略实现: Prompt Order Data (全局数据)
    // --------------------------------------------------------

    function _getStatesViaData() {
        try {
            const order = _findPromptOrderFromGlobals();
            if (!order) return null;

            return _normalizeOrderToStates(order);
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error in data strategy:`, e);
            return null;
        }
    }

    function _setStatesViaData(states) {
        try {
            const order = _findPromptOrderFromGlobals();
            if (!order) return false;

            let changed = false;
            const stateMap = new Map(states.map(s => [s.identifier, s.enabled]));

            for (const item of order) {
                const id = item.identifier ?? item.name ?? item.id;
                if (!id || !stateMap.has(id)) continue;

                const shouldBeEnabled = stateMap.get(id);
                if ('enabled' in item && item.enabled !== shouldBeEnabled) {
                    item.enabled = shouldBeEnabled;
                    changed = true;
                }
            }

            if (changed) {
                saveSettingsDebounced();
                _tryRefreshUI();
            }

            return true;
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error setting states via data:`, e);
            return false;
        }
    }

    // --------------------------------------------------------
    // 策略实现: DOM (最后兜底)
    // --------------------------------------------------------

    function _getStatesViaDOM() {
        try {
            const container = _findPromptManagerContainer();
            if (!container) return null;

            const result = _findPromptItems(container);
            if (!result || !result.items || result.items.length === 0) return null;

            const states = [];
            result.items.forEach(item => {
                const identifier = item.getAttribute(result.identifierAttr);
                if (!identifier) return;

                const enabled = _detectEnabledState(item);
                states.push({ identifier, enabled });
            });

            return states.length > 0 ? states : null;
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error in DOM strategy:`, e);
            return null;
        }
    }

    function _setStatesViaDOM(states) {
        try {
            const container = _findPromptManagerContainer();
            if (!container) return false;

            const result = _findPromptItems(container);
            if (!result || !result.items || result.items.length === 0) return false;

            const stateMap = new Map(states.map(s => [s.identifier, s.enabled]));
            let anyChanged = false;

            result.items.forEach(item => {
                const identifier = item.getAttribute(result.identifierAttr);
                if (!identifier || !stateMap.has(identifier)) return;

                const shouldBeEnabled = stateMap.get(identifier);
                const wasToggled = _setDOMEnabledState(item, shouldBeEnabled);
                if (wasToggled) anyChanged = true;
            });

            return true;
        } catch (e) {
            console.error(`${LOG_PREFIX} [Adapter] Error setting states via DOM:`, e);
            return false;
        }
    }

    // --------------------------------------------------------
    // 通用辅助
    // --------------------------------------------------------

    /**
     * 将 order 数组标准化为 PromptStateEntry 格式
     */
    function _normalizeOrderToStates(order) {
        if (!Array.isArray(order) || order.length === 0) return null;

        const states = [];
        for (const item of order) {
            if (!item || typeof item !== 'object') continue;

            // 自适应识别 identifier 字段
            const identifier = item.identifier ?? item.name ?? item.id;
            if (!identifier) continue;

            // 自适应识别 enabled 字段
            let enabled = true;
            if ('enabled' in item) {
                enabled = item.enabled !== false;
            } else if ('active' in item) {
                enabled = item.active !== false;
            } else if ('disabled' in item) {
                enabled = !item.disabled;
            }

            states.push({ identifier, enabled });
        }

        return states.length > 0 ? states : null;
    }

    /**
     * 触发 PromptManager 的更新（渲染 + 保存）
     */
    function _triggerPMUpdate(pm) {
        // 尝试调用渲染方法
        const renderNames = ['render', 'renderPrompts', 'refresh', 'update', 'updateUI'];
        for (const name of renderNames) {
            if (typeof pm[name] === 'function') {
                try {
                    pm[name]();
                    break;
                } catch (e) {
                    // 继续尝试下一个
                }
            }
        }

        // 尝试保存设置
        const saveNames = ['saveServiceSettings', 'save', 'saveSettings'];
        let saved = false;
        for (const name of saveNames) {
            if (typeof pm[name] === 'function') {
                try {
                    pm[name]();
                    saved = true;
                    break;
                } catch (e) {
                    // 继续尝试下一个
                }
            }
        }

        if (!saved) {
            saveSettingsDebounced();
        }
    }

    /**
     * 尝试刷新 Prompt Manager UI
     */
    function _tryRefreshUI() {
        try {
            const context = getContext();
            const pmGetter = _findPromptManagerGetter(context);
            if (pmGetter) {
                const pm = pmGetter();
                if (pm) {
                    _triggerPMUpdate(pm);
                    return;
                }
            }
        } catch (e) {
            // fallthrough
        }

        // 触发 ST 内部事件来通知设置变更
        try {
            if (eventSource && typeof eventSource.emit === 'function') {
                eventSource.emit('settings_updated');
            }
        } catch (e) {
            // ignore
        }
    }

    // --------------------------------------------------------
    // 变化监听
    // --------------------------------------------------------

    /**
     * 设置 prompt entry 变化监听
     * @param {Function} callback - 变化回调
     * @returns {Function} 清理函数
     */
    function watchChanges(callback) {
        const cleanups = [];

        // 监听策略 1: ST 事件系统
        const eventNames = [
            'prompt_manager_updated',
            'promptManagerUpdated',
            'PROMPT_MANAGER_UPDATED',
        ];

        // 检测哪些事件类型存在
        if (event_types) {
            for (const key of Object.keys(event_types)) {
                const val = event_types[key];
                if (typeof val === 'string' && val.toLowerCase().includes('prompt')) {
                    const handler = () => callback();
                    eventSource.on(val, handler);
                    cleanups.push(() => eventSource.off(val, handler));
                }
            }
        }

        // 监听策略 2: 如果有 DOM，设置 MutationObserver
        const setupDOMWatch = () => {
            const container = _findPromptManagerContainer();
            if (!container) return;

            const observer = new MutationObserver((mutations) => {
                // 只关注可能影响 enabled 状态的变化
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes') {
                        const attr = mutation.attributeName || '';
                        if (attr.includes('enabled') || attr.includes('active') ||
                            attr.includes('checked') || attr === 'class') {
                            callback();
                            return;
                        }
                    }
                    if (mutation.type === 'childList') {
                        // checkbox 状态变化可能通过 childList 体现
                        callback();
                        return;
                    }
                }
            });

            observer.observe(container, {
                attributes: true,
                subtree: true,
                childList: true,
                attributeFilter: ['class', 'data-enabled', 'data-pm-enabled', 'data-active', 'checked'],
            });

            cleanups.push(() => observer.disconnect());
        };

        // 延迟设置 DOM 监听（等待 DOM 就绪）
        const domTimer = setTimeout(setupDOMWatch, 2000);
        cleanups.push(() => clearTimeout(domTimer));

        // 监听策略 3: 使用事件委托监听 change 事件
        const changeHandler = (e) => {
            const target = e.target;
            if (!target) return;

            // 检查事件来源是否在 prompt manager 区域内
            const container = _findPromptManagerContainer();
            if (container && container.contains(target)) {
                if (target.type === 'checkbox' || target.tagName === 'INPUT') {
                    callback();
                }
            }
        };

        document.addEventListener('change', changeHandler, true);
        cleanups.push(() => document.removeEventListener('change', changeHandler, true));

        // 返回清理函数
        return () => {
            cleanups.forEach(fn => {
                try { fn(); } catch (e) { /* ignore */ }
            });
        };
    }

    // 公开 API
    return {
        getPromptStates,
        setPromptStates,
        invalidateCache,
        getCurrentStrategy,
        watchChanges,
    };
})();

// ============================================================
// 设置管理
// ============================================================

/**
 * 加载插件设置
 */
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    Object.assign(extension_settings[MODULE_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[MODULE_NAME],
    });
    console.log(`${LOG_PREFIX} Settings loaded`, extension_settings[MODULE_NAME]);
}

// ============================================================
// 核心功能函数
// ============================================================

/**
 * 获取当前活动聊天的 ID
 * @returns {string|null}
 */
function getCurrentChatId() {
    try {
        const context = getContext();
        if (!context) return null;

        // Feature Detection: 检测 chatId 的位置
        if (context.chatId) return String(context.chatId);
        if (context.chat_id) return String(context.chat_id);
        if (context.getCurrentChatId && typeof context.getCurrentChatId === 'function') {
            const id = context.getCurrentChatId();
            if (id) return String(id);
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================
// 配置保存/恢复/删除
// ============================================================

/**
 * 保存当前 Prompt Entry 状态到聊天元数据
 * @param {boolean} showToast - 是否显示提示
 * @returns {boolean}
 */
function saveConfig(showToast = false) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot save`);
        return false;
    }

    // 通过 Adapter 获取状态
    const states = PromptStateAdapter.getPromptStates();
    if (!states) {
        console.warn(`${LOG_PREFIX} Cannot read prompt entry states (strategy: ${PromptStateAdapter.getCurrentStrategy()})`);
        if (showToast) {
            toastr.warning('无法读取 Prompt Entry 状态', 'Prompt Keeper');
        }
        return false;
    }

    const context = getContext();
    if (!context.chatMetadata) {
        console.warn(`${LOG_PREFIX} Chat metadata not available`);
        return false;
    }

    context.chatMetadata[MODULE_NAME] = {
        entries: states,
        updatedAt: new Date().toISOString(),
        version: 2,
        strategy: PromptStateAdapter.getCurrentStrategy(),
    };

    saveMetadataDebounced();
    console.log(`${LOG_PREFIX} Saved config for chat: ${chatId} (${states.length} entries, strategy: ${PromptStateAdapter.getCurrentStrategy()})`);

    if (showToast) {
        toastr.success(`Prompt 配置已保存 (${states.length} 条目)`, 'Prompt Keeper');
    }

    updateStatusDisplay();
    return true;
}

/**
 * 从聊天元数据中恢复 Prompt Entry 配置
 * @param {boolean} showToast
 * @returns {boolean}
 */
function restoreConfig(showToast = false) {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot restore`);
        return false;
    }

    const context = getContext();
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        console.log(`${LOG_PREFIX} No saved config for chat: ${chatId}`);
        if (showToast) {
            toastr.warning('未找到已保存的配置', 'Prompt Keeper');
        }
        return false;
    }

    const savedData = context.chatMetadata[MODULE_NAME];
    const entries = savedData.entries;

    if (!entries || entries.length === 0) {
        console.warn(`${LOG_PREFIX} Saved config is empty`);
        return false;
    }

    // 通过 Adapter 设置状态
    const success = PromptStateAdapter.setPromptStates(entries);

    if (success) {
        console.log(`${LOG_PREFIX} Restored config for chat: ${chatId} (${entries.length} entries)`);
        if (showToast) {
            toastr.success(`Prompt 配置已恢复 (${entries.length} 条目)`, 'Prompt Keeper');
        }
    } else {
        console.warn(`${LOG_PREFIX} Failed to restore config (strategy: ${PromptStateAdapter.getCurrentStrategy()})`);
        if (showToast) {
            toastr.error('恢复配置失败', 'Prompt Keeper');
        }
    }

    updateStatusDisplay();
    return success;
}

/**
 * 删除当前聊天的已保存配置
 * @returns {boolean}
 */
function deleteConfig() {
    const chatId = getCurrentChatId();
    if (!chatId) {
        console.warn(`${LOG_PREFIX} No active chat, cannot delete`);
        return false;
    }

    const context = getContext();
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        toastr.info('当前聊天没有已保存的配置', 'Prompt Keeper');
        return false;
    }

    delete context.chatMetadata[MODULE_NAME];
    saveMetadataDebounced();
    console.log(`${LOG_PREFIX} Deleted config for chat: ${chatId}`);
    toastr.success('Prompt 配置已删除', 'Prompt Keeper');

    updateStatusDisplay();
    return true;
}

// ============================================================
// 事件处理
// ============================================================

/**
 * 聊天切换事件处理
 */
function onChatChanged() {
    const chatId = getCurrentChatId();
    if (!chatId) return;

    console.log(`${LOG_PREFIX} Chat changed to: ${chatId}`);

    // Adapter 缓存失效（新聊天可能有不同的 prompt 配置）
    PromptStateAdapter.invalidateCache();

    // 延迟执行，确保聊天元数据已完全加载
    setTimeout(() => {
        updateStatusDisplay();

        const context = getContext();
        if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
            return;
        }

        const settings = extension_settings[MODULE_NAME];
        if (!settings.enabled) return;

        switch (settings.restoreMode) {
            case 'auto':
                restoreConfig(false);
                break;
            case 'ask':
                showRestoreDialog();
                break;
            case 'notify':
                showRestoreNotification();
                break;
        }
    }, 500);
}

/**
 * 恢复确认对话框（询问模式）
 */
function showRestoreDialog() {
    const result = confirm('[Prompt Keeper]\n发现已保存的 Prompt Entry 配置。\n是否恢复？');
    if (result) {
        restoreConfig(true);
    }
}

/**
 * 恢复通知（通知模式）
 */
function showRestoreNotification() {
    toastr.info(
        '<span>发现已保存的 Prompt 配置。<br><button class="btn btn-primary btn-sm pk-restore-toast-btn" style="margin-top:5px;">点击恢复</button></span>',
        'Prompt Keeper',
        {
            timeOut: 10000,
            extendedTimeOut: 5000,
            closeButton: true,
            allowHtml: true,
            onclick: null,
        }
    );

    setTimeout(() => {
        const handler = (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('pk-restore-toast-btn')) {
                restoreConfig(true);
                const toast = e.target.closest('.toast');
                if (toast) toast.style.display = 'none';
            }
        };
        document.addEventListener('click', handler, { once: true, capture: true });
        // 清理：10 秒后移除
        setTimeout(() => document.removeEventListener('click', handler, true), 15000);
    }, 100);
}

// ============================================================
// Prompt Entry 状态监听（自动保存）
// ============================================================

/** 防抖定时器 */
let saveTimeout = null;

/** watcher 清理函数 */
let watcherCleanup = null;

/**
 * Prompt Entry toggle 变化时的回调
 */
function onPromptEntryToggled() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled) return;

    const chatId = getCurrentChatId();
    if (!chatId) return;

    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
        saveConfig(false);
        console.log(`${LOG_PREFIX} Auto-saved after toggle change`);
    }, 800);
}

/**
 * 设置 Prompt Entry 状态变化的监听器
 * 通过 Adapter 的 watchChanges 实现
 */
function setupPromptEntryWatcher() {
    // 清理旧的 watcher
    if (watcherCleanup) {
        watcherCleanup();
        watcherCleanup = null;
    }

    watcherCleanup = PromptStateAdapter.watchChanges(onPromptEntryToggled);

    // 聊天变更后重新设置 watcher
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 延迟重新绑定，等待新聊天 DOM 就绪
        setTimeout(() => {
            if (watcherCleanup) {
                watcherCleanup();
            }
            watcherCleanup = PromptStateAdapter.watchChanges(onPromptEntryToggled);
        }, 1500);
    });
}

// ============================================================
// UI 界面
// ============================================================

/**
 * 更新状态显示
 */
function updateStatusDisplay() {
    const statusEl = document.getElementById('pk-status');
    if (!statusEl) return;

    const chatId = getCurrentChatId();
    if (!chatId) {
        statusEl.innerHTML = '<span class="pk-status-nosave">⚠ 无活动聊天</span>';
        return;
    }

    const context = getContext();
    if (!context.chatMetadata || !context.chatMetadata[MODULE_NAME]) {
        statusEl.innerHTML = '<span class="pk-status-nosave">⚠ Not Saved</span>';
        return;
    }

    const savedData = context.chatMetadata[MODULE_NAME];
    const date = new Date(savedData.updatedAt);
    const formattedDate = date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });

    const entryCount = savedData.entries ? savedData.entries.length : 0;
    statusEl.innerHTML = `<span class="pk-status-saved">✓ Saved (${entryCount})<br><small>${formattedDate}</small></span>`;
}

/**
 * 注入操作面板 UI
 * 使用 Feature Detection 寻找合适的注入位置
 */
function injectUI() {
    const buttonHtml = `
        <div id="pk-container" class="pk-container">
            <div class="pk-header">
                <span class="pk-title">Prompt Keeper</span>
                <div id="pk-status" class="pk-status"></div>
            </div>
            <div class="pk-buttons">
                <button id="pk-save-btn" class="menu_button" title="保存当前 Prompt Entry 配置">
                    💾 Save
                </button>
                <button id="pk-restore-btn" class="menu_button" title="恢复已保存的 Prompt Entry 配置">
                    ↺ Restore
                </button>
                <button id="pk-delete-btn" class="menu_button" title="删除当前聊天的保存配置">
                    🗑 Delete
                </button>
            </div>
            <div class="pk-debug-info">
                <small id="pk-strategy-display" class="pk-description"></small>
            </div>
        </div>
    `;

    /**
     * 查找注入目标
     * 不假设固定 ID 或 class，通过特征检测
     */
    const findInjectionTarget = () => {
        // 策略 1: 查找包含 "prompt" 和 "manager" 的容器
        const allElements = document.querySelectorAll('[id]');
        for (const el of allElements) {
            const id = el.id.toLowerCase();
            if (id.includes('prompt') && id.includes('manager') && !id.includes('list')) {
                return { element: el, position: 'afterbegin' };
            }
        }

        // 策略 2: 查找 AI/completion 配置区域
        for (const el of allElements) {
            const id = el.id.toLowerCase();
            if ((id.includes('ai') || id.includes('completion')) &&
                (id.includes('config') || id.includes('response'))) {
                return { element: el, position: 'afterbegin' };
            }
        }

        // 策略 3: 在 extensions 设置区域旁边注入
        const extSettings = document.getElementById('extensions_settings') ||
                           document.getElementById('extensions_settings2');
        if (extSettings) {
            return { element: extSettings, position: 'afterbegin' };
        }

        return null;
    };

    const injectTarget = () => {
        if (document.getElementById('pk-container')) return true;

        const target = findInjectionTarget();
        if (target) {
            target.element.insertAdjacentHTML(target.position, buttonHtml);
            bindButtonEvents();
            updateStatusDisplay();
            updateStrategyDisplay();
            return true;
        }

        return false;
    };

    // 初次尝试
    if (!injectTarget()) {
        // DOM 未就绪，使用重试
        let retryCount = 0;
        const maxRetries = 30;
        const retryInterval = setInterval(() => {
            retryCount++;
            if (injectTarget() || retryCount >= maxRetries) {
                clearInterval(retryInterval);
                if (retryCount >= maxRetries) {
                    console.warn(`${LOG_PREFIX} Could not find injection target after ${maxRetries} retries`);
                }
            }
        }, 1000);
    }

    // 聊天变更后确保 UI 存在
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            if (!document.getElementById('pk-container')) {
                injectTarget();
            }
            updateStatusDisplay();
            updateStrategyDisplay();
        }, 600);
    });
}

/**
 * 更新策略显示（调试用）
 */
function updateStrategyDisplay() {
    const el = document.getElementById('pk-strategy-display');
    if (!el) return;
    const strategy = PromptStateAdapter.getCurrentStrategy();
    el.textContent = `Adapter: ${strategy}`;
}

/**
 * 绑定按钮事件
 */
function bindButtonEvents() {
    const saveBtn = document.getElementById('pk-save-btn');
    const restoreBtn = document.getElementById('pk-restore-btn');
    const deleteBtn = document.getElementById('pk-delete-btn');

    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveConfig(true));
    }
    if (restoreBtn) {
        restoreBtn.addEventListener('click', () => restoreConfig(true));
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            if (confirm('确定要删除当前聊天的 Prompt Entry 配置吗？')) {
                deleteConfig();
            }
        });
    }
}

/**
 * 加载设置面板 UI
 */
async function loadSettingsUI() {
    // 尝试加载外部 settings.html
    try {
        const settingsPath = 'scripts/extensions/third-party/prompt-keeper/settings.html';
        const altPaths = [
            `scripts/extensions/third-party/${MODULE_NAME}/settings.html`,
            'extensions/prompt-keeper/settings.html',
        ];

        let settingsHtml = null;

        // 尝试 fetch settings.html
        for (const path of [settingsPath, ...altPaths]) {
            try {
                const response = await fetch(path);
                if (response.ok) {
                    settingsHtml = await response.text();
                    break;
                }
            } catch (e) {
                // continue
            }
        }

        // 如果 fetch 失败，使用内联 HTML
        if (!settingsHtml) {
            settingsHtml = generateSettingsHtml();
        }

        // 查找设置容器
        const settingsContainer = document.getElementById('extensions_settings2') ||
                                 document.getElementById('extensions_settings');
        if (settingsContainer) {
            settingsContainer.insertAdjacentHTML('beforeend', settingsHtml);
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to load settings UI:`, e);
        // 使用内联 HTML 兜底
        const settingsContainer = document.getElementById('extensions_settings2') ||
                                 document.getElementById('extensions_settings');
        if (settingsContainer) {
            settingsContainer.insertAdjacentHTML('beforeend', generateSettingsHtml());
        }
    }

    // 设置初始值
    const enabledCheckbox = document.getElementById('pk-enabled');
    const restoreModeSelect = document.getElementById('pk-restore-mode');

    if (enabledCheckbox) {
        enabledCheckbox.checked = extension_settings[MODULE_NAME].enabled;
    }
    if (restoreModeSelect) {
        restoreModeSelect.value = extension_settings[MODULE_NAME].restoreMode;
    }

    // 绑定设置变更事件（使用原生事件委托）
    document.addEventListener('change', (e) => {
        if (e.target.id === 'pk-enabled') {
            extension_settings[MODULE_NAME].enabled = e.target.checked;
            saveSettingsDebounced();
        }
        if (e.target.id === 'pk-restore-mode') {
            extension_settings[MODULE_NAME].restoreMode = e.target.value;
            saveSettingsDebounced();
        }
    });
}

/**
 * 生成设置面板 HTML（当无法加载外部文件时）
 */
function generateSettingsHtml() {
    const settings = extension_settings[MODULE_NAME];
    return `
        <div class="pk-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Prompt Keeper</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="pk-setting-item">
                        <label>
                            <input type="checkbox" id="pk-enabled" ${settings.enabled ? 'checked' : ''}>
                            启用插件
                        </label>
                    </div>
                    <div class="pk-setting-item">
                        <label for="pk-restore-mode">恢复模式：</label>
                        <select id="pk-restore-mode" class="text_pole">
                            <option value="auto" ${settings.restoreMode === 'auto' ? 'selected' : ''}>自动恢复</option>
                            <option value="ask" ${settings.restoreMode === 'ask' ? 'selected' : ''}>询问恢复</option>
                            <option value="notify" ${settings.restoreMode === 'notify' ? 'selected' : ''}>仅提示</option>
                        </select>
                    </div>
                    <hr>
                    <small class="pk-description">
                        <b>自动恢复</b>：切换聊天时自动恢复配置<br>
                        <b>询问恢复</b>：切换聊天时弹出确认对话框<br>
                        <b>仅提示</b>：显示通知，手动点击恢复
                    </small>
                    <hr>
                    <small class="pk-description">
                        <b>版本：</b>2.0.0 | <b>兼容：</b>SillyTavern 1.12+<br>
                        <b>架构：</b>Prompt State Adapter + Feature Detection
                    </small>
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// 插件入口
// ============================================================

jQuery(async () => {
    loadSettings();
    await loadSettingsUI();
    injectUI();

    // 监听聊天切换
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 设置自动保存监听（通过 Adapter）
    setupPromptEntryWatcher();

    console.log(`${LOG_PREFIX} Extension loaded (v2.0.0, Adapter strategy: ${PromptStateAdapter.getCurrentStrategy()})`);
});
