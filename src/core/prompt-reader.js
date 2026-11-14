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
 * 将 prompt_order 瘦身为仅含必要字段与必要分组的紧凑结构，
 * 避免多角色冗余 order 数组及额外字段导致单个槽位膨胀至数百 KB。
 */
export function compactPromptOrder(rawPromptOrder, promptsMap = null, activeCharacterId = null) {
    if (!Array.isArray(rawPromptOrder) || rawPromptOrder.length === 0) return null;

    // 情况 1：DOM 回退读取的扁平字符串/对象数组
    const first = rawPromptOrder[0];
    if (typeof first === 'string' || (first && typeof first === 'object' && !Array.isArray(first.order) && first.identifier)) {
        const flat = [];
        for (const item of rawPromptOrder) {
            const id = getPromptItemIdentifier(item);
            if (typeof id === 'string' && id) {
                flat.push(id);
            }
        }
        return flat.length > 0 ? flat : null;
    }

    // 情况 2：SillyTavern 标准 [{ character_id, order: [{ identifier, enabled }] }]
    const validEntries = rawPromptOrder.filter(e => e && Array.isArray(e.order) && e.order.length > 0);
    if (validEntries.length === 0) return null;

    let selectedEntries = validEntries;
    if (validEntries.length > 2) {
        const picked = [];
        const addUnique = (entry) => {
            if (entry && !picked.includes(entry)) picked.push(entry);
        };
        if (activeCharacterId !== null && activeCharacterId !== undefined) {
            addUnique(validEntries.find(e => String(e.character_id) === String(activeCharacterId)));
        }
        addUnique(validEntries.find(e => Number(e.character_id) === 100001));
        addUnique(validEntries.find(e => Number(e.character_id) === 100000));
        addUnique(validEntries[0]);
        selectedEntries = picked.slice(0, 2);
    }

    const compacted = [];
    for (const entry of selectedEntries) {
        const cleanOrder = [];
        for (const item of entry.order) {
            const id = getPromptItemIdentifier(item);
            if (typeof id !== 'string' || !id) continue;
            const enabled =
                promptsMap && hasOwnSlot(promptsMap, id)
                    ? Boolean(promptsMap[id])
                    : item && typeof item === 'object'
                      ? item.enabled !== false
                      : true;
            cleanOrder.push({ identifier: id, enabled });
        }
        if (cleanOrder.length > 0) {
            compacted.push({
                character_id: entry.character_id !== undefined ? entry.character_id : 100001,
                order: cleanOrder,
            });
        }
    }

    return compacted.length > 0 ? compacted : null;
}

/**
 * DOM 回退：从页面 Prompt Manager 列表 DOM（`#completion_prompt_manager_list`）中读取条目开关与顺序
 * 严格对齐 SillyTavern `public/scripts/PromptManager.js` 的真实 DOM 结构：
 * - 列表项：`li.completion_prompt_manager_prompt[data-pm-identifier]`（禁用态含 `completion_prompt_manager_prompt_disabled`）
 * - 切换按钮：`.prompt-manager-toggle-action`（启用含 `fa-toggle-on`，禁用含 `fa-toggle-off`）
 */
export function readPromptStatesFromDOM() {
    if (typeof jQuery === 'undefined') return null;

    const $container = jQuery('#completion_prompt_manager_list').first();
    if ($container.length === 0) {
        console.debug(LOG_PREFIX, 'DOM container #completion_prompt_manager_list not found for fallback read.');
        return null;
    }

    const prompts = {};
    const orderArray = [];

    $container.find('li.completion_prompt_manager_prompt[data-pm-identifier], [data-pm-identifier]').each(function () {
        const $row = jQuery(this);
        const identifier = $row.attr('data-pm-identifier');
        if (!identifier) return;

        const $toggle = $row.find('.prompt-manager-toggle-action').first();
        if ($toggle.length > 0) {
            prompts[identifier] = $toggle.hasClass('fa-toggle-on') && !$toggle.hasClass('fa-toggle-off');
        } else {
            prompts[identifier] = !$row.hasClass('completion_prompt_manager_prompt_disabled');
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
                const activeChId = ctx && ctx.characterId !== undefined ? ctx.characterId : null;
                promptOrder = compactPromptOrder(oaiSettings.prompt_order, prompts, activeChId);
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
