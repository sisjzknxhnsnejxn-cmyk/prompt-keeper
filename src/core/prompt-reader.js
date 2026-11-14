/**
 * Prompt Keeper - Prompt 状态与顺序读取器
 * 优先从 SillyTavern chatCompletionSettings API 层读取，回退到 DOM 层读取。
 */

import { LOG_PREFIX } from '../config/constants.js';
import { hasOwnSlot } from '../utils/format.js';
import { getCtxSafe } from '../utils/st-context.js';

/**
 * 获取 promptOrder 条目的 identifier
 */
export function getPromptItemIdentifier(item) {
    return item && typeof item === 'object' ? item.identifier : item;
}

/**
 * 将 prompts 映射表中的 enabled 状态同步到 prompt_order 数组中
 */
export function normalizePromptOrderEnabled(promptOrder, prompts) {
    if (!Array.isArray(promptOrder) || !prompts) return;

    for (const entry of promptOrder) {
        if (!entry || !Array.isArray(entry.order)) continue;
        for (const item of entry.order) {
            if (!item || typeof item !== 'object' || !item.identifier) continue;
            if (hasOwnSlot(prompts, item.identifier)) {
                item.enabled = prompts[item.identifier];
            }
        }
    }
}

/**
 * DOM 回退：从页面 Prompt Manager 列表 DOM 中读取条目开关与顺序
 */
export function readPromptStatesFromDOM() {
    if (typeof jQuery === 'undefined') return null;

    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'DOM container not found for fallback read.');
        return null;
    }

    const prompts = {};
    const orderArray = [];

    $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
        const $row = jQuery(this);
        const identifier = $row.attr('data-pm-identifier') || $row.attr('data-prompt-id');
        if (!identifier) return;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            prompts[identifier] = Boolean($checkbox.prop('checked'));
        } else {
            const $toggle = $row.find('.prompt_manager_prompt_toggle');
            if ($toggle.length > 0) {
                prompts[identifier] =
                    $toggle.hasClass('enabled') || $toggle.attr('data-enabled') === 'true';
            }
        }

        orderArray.push(identifier);
    });

    if (Object.keys(prompts).length === 0) {
        console.debug(LOG_PREFIX, 'No prompt entries found in DOM.');
        return null;
    }

    console.debug(LOG_PREFIX, 'Read prompt states from DOM fallback');
    return { prompts: Object.assign({}, prompts), promptOrder: orderArray };
}

/**
 * 读取当前 Prompt Manager 的条目启用状态与排列顺序（优先 API，回退 DOM）
 * @returns {{ prompts: Record<string, boolean>, promptOrder: Array|null } | null}
 */
export function readPromptStates() {
    try {
        const ctx = getCtxSafe();
        const oaiSettings = ctx ? ctx.chatCompletionSettings : null;

        if (oaiSettings && Array.isArray(oaiSettings.prompts) && oaiSettings.prompts.length > 0) {
            const prompts = {};
            const enabledFromOrder = {};

            if (Array.isArray(oaiSettings.prompt_order)) {
                for (const entry of oaiSettings.prompt_order) {
                    if (entry && Array.isArray(entry.order)) {
                        for (const item of entry.order) {
                            if (item && item.identifier) {
                                enabledFromOrder[item.identifier] = item.enabled !== false;
                            }
                        }
                    }
                }
            }

            for (const p of oaiSettings.prompts) {
                if (p && p.identifier) {
                    prompts[p.identifier] = hasOwnSlot(enabledFromOrder, p.identifier)
                        ? enabledFromOrder[p.identifier]
                        : p.enabled !== false;
                }
            }

            let promptOrder = null;
            if (Array.isArray(oaiSettings.prompt_order)) {
                promptOrder = JSON.parse(JSON.stringify(oaiSettings.prompt_order));
                normalizePromptOrderEnabled(promptOrder, prompts);
            }

            if (Object.keys(prompts).length > 0) {
                console.debug(LOG_PREFIX, 'Read prompt states from API');
                return { prompts: Object.assign({}, prompts), promptOrder };
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to read from chatCompletionSettings:', e);
    }

    return readPromptStatesFromDOM();
}
