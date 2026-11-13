/**
 * Prompt Keeper - Prompt 状态与排序合并写回模块
 * 负责将已保存的条目开关与排列顺序应用到 chatCompletionSettings 或 DOM 回退层。
 */

import { LOG_PREFIX } from '../config/constants.js';
import { getCtxSafe } from '../utils/st-context.js';
import { findCompatiblePromptOrderEntry, findPromptEnabledMismatches } from './prompt-dirty-check.js';
import { getPromptItemIdentifier, normalizePromptOrderEnabled } from './prompt-reader.js';

export function syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers, skipped = null) {
    if (!oaiSettings || !savedPrompts) return;

    const promptMap = new Map(
        Array.isArray(oaiSettings.prompts)
            ? oaiSettings.prompts.filter((p) => p && p.identifier).map((prompt) => [prompt.identifier, prompt])
            : []
    );

    for (const [identifier, enabled] of Object.entries(savedPrompts)) {
        if (currentIdentifiers && !currentIdentifiers.has(identifier)) {
            if (skipped && !skipped.includes(identifier)) skipped.push(identifier);
            continue;
        }

        const prompt = promptMap.get(identifier);
        if (prompt) {
            prompt.enabled = enabled;
        }
    }

    if (Array.isArray(oaiSettings.prompt_order)) {
        normalizePromptOrderEnabled(oaiSettings.prompt_order, savedPrompts);
    }
}

/**
 * 在不移动新增条目槽位的前提下，恢复存档条目的相对顺序。
 */
export function restoreSavedOrderKeepingNewSlots(
    currentItems,
    savedItems,
    skipped,
    copySavedEnabled = false
) {
    if (!Array.isArray(currentItems) || !Array.isArray(savedItems)) return currentItems;

    const currentQueues = new Map();
    for (const item of currentItems) {
        const identifier = getPromptItemIdentifier(item);
        if (!identifier) continue;
        if (!currentQueues.has(identifier)) currentQueues.set(identifier, []);
        currentQueues.get(identifier).push(item);
    }

    const restoredItems = [];
    const restoredIdentifiers = new Set();
    for (const savedItem of savedItems) {
        const identifier = getPromptItemIdentifier(savedItem);
        if (!identifier) continue;

        const queue = currentQueues.get(identifier);
        if (!queue || queue.length === 0) {
            if (skipped && !skipped.includes(identifier)) skipped.push(identifier);
            continue;
        }

        const currentItem = queue.shift();
        if (
            copySavedEnabled &&
            savedItem &&
            typeof savedItem === 'object' &&
            currentItem &&
            typeof currentItem === 'object' &&
            savedItem.enabled !== undefined
        ) {
            currentItem.enabled = savedItem.enabled;
        }
        restoredItems.push(currentItem);
        restoredIdentifiers.add(identifier);
    }

    let restoredIndex = 0;
    return currentItems.map((item) => {
        const identifier = getPromptItemIdentifier(item);
        if (!identifier || !restoredIdentifiers.has(identifier)) return item;
        return restoredItems[restoredIndex++] ?? item;
    });
}

export function mergePromptOrder(currentOrder, savedOrder, skipped) {
    if (!Array.isArray(currentOrder) || !Array.isArray(savedOrder)) return;

    const currentMap = new Map();
    for (const entry of currentOrder) {
        if (!entry || typeof entry !== 'object') continue;
        const key = entry.character_id !== undefined ? String(entry.character_id) : '__default__';
        currentMap.set(key, entry);
    }

    for (const savedEntry of savedOrder) {
        if (!savedEntry || typeof savedEntry !== 'object') continue;
        const key = savedEntry.character_id !== undefined ? String(savedEntry.character_id) : '__default__';
        let currentEntry = currentMap.get(key);

        if (!currentEntry) {
            currentEntry = findCompatiblePromptOrderEntry(currentOrder, savedEntry);
            if (currentEntry) {
                console.debug(
                    LOG_PREFIX,
                    `mergePromptOrder: character_id=${key} not found; using compatible current prompt_order entry.`
                );
            } else {
                console.debug(
                    LOG_PREFIX,
                    `mergePromptOrder: no matching entry for character_id=${key}, skipping.`
                );
                continue;
            }
        }

        if (!Array.isArray(savedEntry.order) || !Array.isArray(currentEntry.order)) continue;

        currentEntry.order = restoreSavedOrderKeepingNewSlots(
            currentEntry.order,
            savedEntry.order,
            skipped,
            true
        );
    }
}

export function applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped) {
    if (!oaiSettings.prompt_order || oaiSettings.prompt_order.length === 0) return;

    for (const entry of oaiSettings.prompt_order) {
        if (!entry || !Array.isArray(entry.order)) continue;
        entry.order = restoreSavedOrderKeepingNewSlots(entry.order, savedOrder, skipped);
    }
}

/**
 * DOM 回退：直接向页面 DOM 复选框应用启用状态（使用属性字典索引，避免特殊字符破坏 CSS 选择器）
 */
export function applyPromptStatesDOM(savedPrompts, skipped) {
    if (typeof jQuery === 'undefined' || !savedPrompts) return;

    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.warn(LOG_PREFIX, 'DOM container not found for apply.');
        return;
    }

    const rowByIdentifier = new Map();
    $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
        const $row = jQuery(this);
        const id = $row.attr('data-pm-identifier') || $row.attr('data-prompt-id');
        if (id && !rowByIdentifier.has(id)) {
            rowByIdentifier.set(id, $row);
        }
    });

    for (const [identifier, enabled] of Object.entries(savedPrompts)) {
        const $row = rowByIdentifier.get(identifier);
        if (!$row) {
            if (skipped && !skipped.includes(identifier)) skipped.push(identifier);
            continue;
        }

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0 && Boolean($checkbox.prop('checked')) !== Boolean(enabled)) {
            $checkbox.prop('checked', Boolean(enabled)).trigger('change');
        }
    }

    console.debug(LOG_PREFIX, 'Applied prompt states via DOM fallback');
}

export function applyPromptStates(savedState, chatIdAtStart) {
    const skipped = [];
    const { prompts: savedPrompts, promptOrder: savedOrder } = savedState || {};

    const ctxAtStart = getCtxSafe();
    if (chatIdAtStart && (!ctxAtStart || ctxAtStart.chatId !== chatIdAtStart)) {
        console.debug(LOG_PREFIX, 'applyPromptStates aborted: chatId changed during restore.');
        return { skipped, aborted: true };
    }

    try {
        const ctx = getCtxSafe();
        const oaiSettings = ctx ? ctx.chatCompletionSettings : null;

        if (oaiSettings && Array.isArray(oaiSettings.prompts)) {
            const currentIdentifiers = new Set(
                oaiSettings.prompts.map((p) => p && p.identifier).filter(Boolean)
            );
            syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers, skipped);

            if (savedOrder && Array.isArray(savedOrder) && Array.isArray(oaiSettings.prompt_order)) {
                if (savedOrder.length > 0 && typeof savedOrder[0] === 'object') {
                    mergePromptOrder(oaiSettings.prompt_order, savedOrder, skipped);
                } else if (savedOrder.length > 0 && typeof savedOrder[0] === 'string') {
                    applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped);
                }
            }

            syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers);

            const mismatched = findPromptEnabledMismatches(oaiSettings, savedPrompts, currentIdentifiers);
            if (mismatched.length > 0) {
                console.debug(
                    LOG_PREFIX,
                    `Detected ${mismatched.length} prompt state mismatch(es) after restore, applying one more precise sync.`,
                    mismatched
                );
                syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers);
            }

            if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }

            const ctxAfter = getCtxSafe();
            if (chatIdAtStart && (!ctxAfter || ctxAfter.chatId !== chatIdAtStart)) {
                console.debug(LOG_PREFIX, 'applyPromptStates: chatId changed after apply, state may be stale.');
                return { skipped, aborted: true };
            }

            console.debug(LOG_PREFIX, 'Applied prompt states via API');
            return { skipped, aborted: false };
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to apply via API, trying DOM fallback:', e);
    }

    if (savedPrompts && typeof savedPrompts === 'object') {
        applyPromptStatesDOM(savedPrompts, skipped);
    }
    return { skipped, aborted: false };
}
