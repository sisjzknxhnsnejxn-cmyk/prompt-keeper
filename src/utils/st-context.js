/**
 * Prompt Keeper - SillyTavern 上下文与官方/内部模块接口封装
 */

import { CHAT_COMPLETION_API_ID } from '../config/constants.js';
import { openConfirmModal, openSaveNameInputModal } from '../ui/input-modal.js';

let cachedOpenAIModulePromise = null;

/**
 * 动态导入酒馆内置 `public/scripts/openai.js` 模块（访问官方导出的 promptManager / oai_settings 等）
 * 优先使用基于当前脚本位置的相对 URL（兼容反向代理子路径部署），回退到 `/scripts/openai.js`。
 */
export async function getSillyTavernOpenAIModule() {
    if (typeof window === 'undefined') return null;
    if (!cachedOpenAIModulePromise) {
        cachedOpenAIModulePromise = (async () => {
            try {
                const relativeUrl = new URL('../../../../openai.js', import.meta.url).href;
                return await import(relativeUrl);
            } catch (_) {
                try {
                    return await import('/scripts/openai.js');
                } catch (__) {
                    return null;
                }
            }
        })();
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
 * 持久化当前聊天元数据（遵循 SillyTavern 官方规范：直接原地修改 ctx.chatMetadata 后调用 saveMetadata，
 * 不调用会替换全局 chat_metadata 对象引用的 updateChatMetadata）
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
 * 判断当前是否处于移动端视图
 */
export function isMobileDevice(ctx = getCtxSafe()) {
    if (!ctx) return false;
    return typeof ctx.isMobile === 'function' ? Boolean(ctx.isMobile()) : Boolean(ctx.isMobile);
}

/**
 * 弹出文本输入框：优先使用内置极简 iOS 适配弹窗，回退到酒馆原生 Popup.show.input / callGenericPopup 或 window.prompt
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
    if (ctx && ctx.Popup && ctx.Popup.show && typeof ctx.Popup.show.input === 'function') {
        try {
            const result = await ctx.Popup.show.input(message, '', defaultValue);
            if (result === null || result === undefined || result === false) {
                return null;
            }
            return String(result);
        } catch (_) {}
    }

    if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_TYPE.INPUT !== undefined) {
        try {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, defaultValue);
            if (result === null || result === undefined || result === false) {
                return null;
            }
            return String(result);
        } catch (_) {}
    }

    if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        return window.prompt(message, defaultValue);
    }
    return null;
}

/**
 * 弹出确认对话框：优先使用内置极简 iOS 适配确认框，回退到酒馆原生 Popup.show.confirm / callGenericPopup 或 window.confirm
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
    if (ctx && ctx.Popup && ctx.Popup.show && typeof ctx.Popup.show.confirm === 'function') {
        try {
            const result = await ctx.Popup.show.confirm(message, '');
            if (ctx.POPUP_RESULT && ctx.POPUP_RESULT.AFFIRMATIVE !== undefined) {
                return result === ctx.POPUP_RESULT.AFFIRMATIVE;
            }
            return Boolean(result);
        } catch (_) {}
    }

    if (ctx && typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_TYPE.CONFIRM !== undefined) {
        try {
            const result = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM);
            if (ctx.POPUP_RESULT && ctx.POPUP_RESULT.AFFIRMATIVE !== undefined) {
                return result === ctx.POPUP_RESULT.AFFIRMATIVE;
            }
            return Boolean(result);
        } catch (_) {}
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return Boolean(window.confirm(message));
    }
    return false;
}
