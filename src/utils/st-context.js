/**
 * Prompt Keeper - SillyTavern 上下文与官方/内部模块接口封装
 */

import { CHAT_COMPLETION_API_ID } from '../config/constants.js';
import { openConfirmModal, openSaveNameInputModal } from '../ui/input-modal.js';

let cachedOpenAIModulePromise = null;

/**
 * 动态导入酒馆内置 `/scripts/openai.js` 模块（原生浏览器环境支持直接访问酒馆内部导出的 promptManager / oai_settings 等）
 * 在非浏览器或路径不可用环境下静默返回 null。
 */
export async function getSillyTavernOpenAIModule() {
    if (typeof window === 'undefined') return null;
    if (!cachedOpenAIModulePromise) {
        cachedOpenAIModulePromise = import('/scripts/openai.js').catch(() => null);
    }
    return cachedOpenAIModulePromise;
}

/**
 * 获取酒馆全局上下文
 */
export function getCtx() {
    if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') {
        throw new Error('SillyTavern.getContext is not available');
    }
    return SillyTavern.getContext();
}

/**
 * 安全获取酒馆上下文，未就绪时返回 null
 */
export function getCtxSafe() {
    try {
        return getCtx();
    } catch (_) {
        return null;
    }
}

/**
 * 判断当前激活的主 API 是否为 Chat Completion ('openai')
 * 若上下文未提供 mainApi 字段，则默认视为兼容放行
 */
export function isChatCompletionActive(ctx = getCtxSafe()) {
    if (!ctx) return false;
    if (!ctx.mainApi) return true;
    return ctx.mainApi === CHAT_COMPLETION_API_ID;
}

/**
 * 获取 Chat Completion 的 PresetManager 实例
 */
export function getChatCompletionPresetManager(ctx = getCtxSafe()) {
    if (!ctx || typeof ctx.getPresetManager !== 'function') return null;
    try {
        return ctx.getPresetManager(CHAT_COMPLETION_API_ID) || ctx.getPresetManager() || null;
    } catch (_) {
        return null;
    }
}

/**
 * 持久化当前聊天元数据
 */
export function persistChatMetadata() {
    const ctx = getCtxSafe();
    if (!ctx) return Promise.resolve();
    if (typeof ctx.saveMetadata === 'function') {
        return ctx.saveMetadata();
    }
    if (typeof ctx.saveMetadataDebounced === 'function') {
        return ctx.saveMetadataDebounced();
    }
    return Promise.resolve();
}

/**
 * 判断當前是否处于移动端视图
 */
export function isMobileDevice(ctx = getCtxSafe()) {
    if (!ctx) return false;
    return typeof ctx.isMobile === 'function' ? Boolean(ctx.isMobile()) : Boolean(ctx.isMobile);
}

/**
 * 弹出文本输入框：优先使用内置极简 iOS 适配弹窗，回退到酒馆原生 Popup 或 window.prompt
 * @param {string} message 提示标题/内容
 * @param {string} defaultValue 默认输入值
 * @returns {Promise<string|null>} 用户输入字符串，取消则返回 null
 */
export async function showInputPopup(message, defaultValue = '') {
    if (typeof jQuery !== 'undefined' && typeof document !== 'undefined') {
        try {
            return await openSaveNameInputModal('保存预设槽位', defaultValue);
        } catch (_) {}
    }

    const ctx = getCtxSafe();
    if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_TYPE.INPUT !== undefined) {
        try {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, defaultValue);
            if (result === null || result === undefined || result === false) {
                return null;
            }
            return String(result);
        } catch (_) {
            // 回退到浏览器原生 prompt
        }
    }

    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        return window.prompt(message, defaultValue);
    }
    return null;
}

/**
 * 弹出确认对话框：优先使用内置极简 iOS 适配确认框，回退到酒馆原生异步 Popup 或 window.confirm
 * @param {string} message 确认提示信息
 * @returns {Promise<boolean>}
 */
export async function showConfirmPopup(message) {
    if (typeof jQuery !== 'undefined' && typeof document !== 'undefined') {
        try {
            return await openConfirmModal(message);
        } catch (_) {}
    }

    const ctx = getCtxSafe();
    if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_TYPE.CONFIRM !== undefined) {
        try {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM);
            if (ctx.POPUP_RESULT && ctx.POPUP_RESULT.AFFIRMATIVE !== undefined) {
                return result === ctx.POPUP_RESULT.AFFIRMATIVE || result === true;
            }
            return Boolean(result);
        } catch (_) {
            // 回退到浏览器原生 confirm
        }
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return Boolean(window.confirm(message));
    }
    return false;
}
