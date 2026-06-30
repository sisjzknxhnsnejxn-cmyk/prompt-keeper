function readPromptStates() {
    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && Array.isArray(oaiSettings.prompts) && oaiSettings.prompts.length > 0) {
            const prompts = {};

            const enabledFromOrder = {};
            if (Array.isArray(oaiSettings.prompt_order)) {
                for (const entry of oaiSettings.prompt_order) {
                    if (Array.isArray(entry.order)) {
                        for (const item of entry.order) {
                            if (item.identifier) {
                                enabledFromOrder[item.identifier] = item.enabled !== false;
                            }
                        }
                    }
                }
            }

            for (const p of oaiSettings.prompts) {
                if (p.identifier) {
                    prompts[p.identifier] = (enabledFromOrder[p.identifier] !== undefined)
                        ? enabledFromOrder[p.identifier]
                        : (p.enabled !== false);
                }
            }

            let promptOrder = null;
            if (Array.isArray(oaiSettings.prompt_order)) {
                promptOrder = JSON.parse(JSON.stringify(oaiSettings.prompt_order));
                normalizePromptOrderEnabled(promptOrder, prompts);
            }

            if (Object.keys(prompts).length > 0) {
                console.debug(LOG_PREFIX, 'Read prompt states from API');
                return { prompts, promptOrder };
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to read from chatCompletionSettings:', e);
    }

    return readPromptStatesFromDOM();
}

function normalizePromptOrderEnabled(promptOrder, prompts) {
    if (!Array.isArray(promptOrder) || !prompts) return;

    for (const entry of promptOrder) {
        if (!entry || !Array.isArray(entry.order)) continue;
        for (const item of entry.order) {
            if (!item || typeof item !== 'object' || !item.identifier) continue;
            if (prompts[item.identifier] !== undefined) {
                item.enabled = prompts[item.identifier];
            }
        }
    }
}

/**
 * DOM 回退：从 DOM 读取 prompt 状态。
 */
function readPromptStatesFromDOM() {
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
            prompts[identifier] = $checkbox.prop('checked');
        } else {
            const $toggle = $row.find('.prompt_manager_prompt_toggle');
            if ($toggle.length > 0) {
                prompts[identifier] = $toggle.hasClass('enabled') || $toggle.attr('data-enabled') === 'true';
            }
        }

        orderArray.push(identifier);
    });

    if (Object.keys(prompts).length === 0) {
        console.debug(LOG_PREFIX, 'No prompt entries found in DOM.');
        return null;
    }

    console.debug(LOG_PREFIX, 'Read prompt states from DOM fallback');
    return { prompts, promptOrder: orderArray };
}

// ========== Dirty Check ==========

/**
 * 比较两个 promptOrder 是否在语义上一致。
 * 只比较 character_id / identifier / enabled，忽略未知字段。
 */
function promptOrderEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;

    // 元素类型不一致（如 DOM 回退的 string[] vs API 的 object[]），无法可靠比较，跳过
    if (a.length > 0 && b.length > 0 && typeof a[0] !== typeof b[0]) return true;

    for (let i = 0; i < a.length; i++) {
        const ai = a[i], bi = b[i];
        if (ai === bi) continue;
        if (typeof ai !== 'object' || typeof bi !== 'object' || ai === null || bi === null) return false;

        if (String(ai.character_id ?? '') !== String(bi.character_id ?? '')) return false;

        if (!Array.isArray(ai.order) || !Array.isArray(bi.order)) {
            if (ai.order !== bi.order) return false;
            continue;
        }
        if (ai.order.length !== bi.order.length) return false;
        for (let j = 0; j < ai.order.length; j++) {
            const oj = ai.order[j], pj = bi.order[j];
            if (oj === pj) continue;
            if (typeof oj !== 'object' || typeof pj !== 'object' || oj === null || pj === null) return false;
            if (oj.identifier !== pj.identifier) return false;
            if (oj.enabled !== pj.enabled) return false;
        }
    }
    return true;
}

/**
 * 脏检查：对比当前状态与保存状态，决定是否需要恢复。
 */
function checkDirtyState(savedState, options = {}) {
    const allowPresetSwitch = options.allowPresetSwitch !== false;
    const result = {
        needsPresetSwitch: false,
        needsEntryRestore: false,
        targetPreset: null,
    };

    if (!savedState || !savedState.prompts) return result;

    if (allowPresetSwitch && savedState.presetName) {
        const currentPreset = getCurrentPresetName();
        if (currentPreset && !isPresetNameMatch(currentPreset, savedState.presetName)) {
            result.needsPresetSwitch = true;
            result.targetPreset = savedState.presetName;
        }
    }

    if (!result.needsPresetSwitch) {
        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
                if (currentStates.prompts[identifier] !== undefined && currentStates.prompts[identifier] !== enabled) {
                    result.needsEntryRestore = true;
                    break;
                }
            }
            if (!result.needsEntryRestore && savedState.promptOrder && currentStates.promptOrder) {
                if (!promptOrderEqual(savedState.promptOrder, currentStates.promptOrder)) {
                    result.needsEntryRestore = true;
                }
            }
        } else {
            result.needsEntryRestore = true;
        }
    } else {
        result.needsEntryRestore = true;
    }

    return result;
}

// ========== Apply States ==========

/**
 * 应用保存的 prompt 状态，优先 API 层，回退 DOM。
 * @param {{ prompts: Object<string, boolean>, promptOrder: Array }} savedState
 * @param {string|null} chatIdAtStart - 竞态检查用
 */
function applyPromptStates(savedState, chatIdAtStart) {
    const skipped = [];
    const { prompts: savedPrompts, promptOrder: savedOrder } = savedState;

    if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) {
        console.debug(LOG_PREFIX, 'applyPromptStates aborted: chatId changed during restore.');
        return { skipped, aborted: true };
    }

    try {
        const ctx = getCtx();
        const oaiSettings = ctx.chatCompletionSettings;

        if (oaiSettings && Array.isArray(oaiSettings.prompts)) {
            const currentIdentifiers = new Set(oaiSettings.prompts.map(p => p.identifier).filter(Boolean));
            syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers, skipped);

            if (savedOrder && Array.isArray(savedOrder) && Array.isArray(oaiSettings.prompt_order)) {
                if (savedOrder.length > 0 && typeof savedOrder[0] === 'object') {
                    mergePromptOrder(oaiSettings.prompt_order, savedOrder, skipped);
                } else if (savedOrder.length > 0 && typeof savedOrder[0] === 'string') {
                    applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped);
                }
            }

            // prompt_order 的历史快照也可能带 enabled。合并顺序后，必须再次以槽位 prompts 为最终权威，
            // 避免同一预设不同槽位恢复时被 savedOrder 或多份 prompt_order entry 反向覆盖。
            syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers);

            const mismatched = findPromptEnabledMismatches(oaiSettings, savedPrompts, currentIdentifiers);
            if (mismatched.length > 0) {
                console.debug(LOG_PREFIX, `Detected ${mismatched.length} prompt state mismatch(es) after restore, applying one more precise sync.`, mismatched);
                syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers);
            }

            if (ctx.saveSettingsDebounced) {
                ctx.saveSettingsDebounced();
            }

            if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) {
                console.debug(LOG_PREFIX, 'applyPromptStates: chatId changed after apply, state may be stale.');
                return { skipped, aborted: true };
            }

            console.debug(LOG_PREFIX, 'Applied prompt states via API');
            return { skipped, aborted: false };
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to apply via API, trying DOM fallback:', e);
    }

    applyPromptStatesDOM(savedPrompts, skipped);
    return { skipped, aborted: false };
}

function syncPromptEnabledStates(oaiSettings, savedPrompts, currentIdentifiers, skipped = null) {
    if (!oaiSettings || !savedPrompts) return;

    const promptMap = new Map(Array.isArray(oaiSettings.prompts)
        ? oaiSettings.prompts.map(prompt => [prompt.identifier, prompt])
        : []);

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

function findPromptEnabledMismatches(oaiSettings, savedPrompts, currentIdentifiers) {
    const mismatched = [];
    if (!oaiSettings || !savedPrompts) return mismatched;

    if (Array.isArray(oaiSettings.prompts)) {
        for (const prompt of oaiSettings.prompts) {
            if (!prompt || !prompt.identifier || savedPrompts[prompt.identifier] === undefined) continue;
            if (currentIdentifiers && !currentIdentifiers.has(prompt.identifier)) continue;
            if ((prompt.enabled !== false) !== savedPrompts[prompt.identifier]) {
                mismatched.push(prompt.identifier);
            }
        }
    }

    if (Array.isArray(oaiSettings.prompt_order)) {
        for (const entry of oaiSettings.prompt_order) {
            if (!entry || !Array.isArray(entry.order)) continue;
            for (const item of entry.order) {
                if (!item || !item.identifier || savedPrompts[item.identifier] === undefined) continue;
                if (currentIdentifiers && !currentIdentifiers.has(item.identifier)) continue;
                if ((item.enabled !== false) !== savedPrompts[item.identifier]) {
                    mismatched.push(item.identifier);
                }
            }
        }
    }

    return [...new Set(mismatched)];
}

function findSavedPromptStateMismatches(savedState) {
    if (!savedState || !savedState.prompts) return [];
    const currentStates = readPromptStates();
    if (!currentStates || !currentStates.prompts) return Object.keys(savedState.prompts);

    const mismatches = [];
    for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
        if (currentStates.prompts[identifier] !== undefined && currentStates.prompts[identifier] !== enabled) {
            mismatches.push(identifier);
        }
    }

    return mismatches;
}

/**
 * 智能合并 prompt_order：按 character_id 匹配，只更新 order 数组。
 */
function mergePromptOrder(currentOrder, savedOrder, skipped) {
    if (!Array.isArray(currentOrder) || !Array.isArray(savedOrder)) return;

    const currentMap = new Map();
    for (const entry of currentOrder) {
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
                console.debug(LOG_PREFIX, `mergePromptOrder: character_id=${key} not found; using compatible current prompt_order entry.`);
            } else {
                console.debug(LOG_PREFIX, `mergePromptOrder: no matching entry for character_id=${key}, skipping.`);
                continue;
            }
        }

        if (!Array.isArray(savedEntry.order) || !Array.isArray(currentEntry.order)) continue;

        const currentOrderMap = new Map(currentEntry.order.map(item => [item.identifier, item]));
        const newOrder = [];

        for (const savedItem of savedEntry.order) {
            const identifier = typeof savedItem === 'object' ? savedItem.identifier : savedItem;
            if (currentOrderMap.has(identifier)) {
                const currentItem = currentOrderMap.get(identifier);
                if (typeof savedItem === 'object' && savedItem.enabled !== undefined) {
                    currentItem.enabled = savedItem.enabled;
                }
                newOrder.push(currentItem);
                currentOrderMap.delete(identifier);
            } else {
                if (identifier) skipped.push(identifier);
            }
        }

        for (const [, item] of currentOrderMap) {
            newOrder.push(item);
        }

        currentEntry.order = newOrder;
    }
}

function findCompatiblePromptOrderEntry(currentOrder, savedEntry) {
    if (!Array.isArray(currentOrder) || !savedEntry || !Array.isArray(savedEntry.order)) return null;

    const savedIdentifiers = new Set(savedEntry.order
        .map(item => (item && typeof item === 'object') ? item.identifier : item)
        .filter(Boolean));
    if (savedIdentifiers.size === 0) return null;

    let bestEntry = null;
    let bestScore = 0;

    for (const entry of currentOrder) {
        if (!entry || !Array.isArray(entry.order)) continue;
        let score = 0;
        for (const item of entry.order) {
            const identifier = item && typeof item === 'object' ? item.identifier : item;
            if (identifier && savedIdentifiers.has(identifier)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
        }
    }

    return bestScore > 0 ? bestEntry : null;
}

/**
 * 从字符串 identifier 列表应用顺序。
 * 字符串格式不含 enabled，上层已在调用前同步 enabled 到 prompt_order。
 */
function applyOrderFromIdentifierList(oaiSettings, savedOrder, currentIdentifiers, skipped) {
    if (!oaiSettings.prompt_order || oaiSettings.prompt_order.length === 0) return;

    for (const entry of oaiSettings.prompt_order) {
        if (!entry.order || !Array.isArray(entry.order)) continue;

        const currentOrderMap = new Map(entry.order.map((item) => [item.identifier, item]));
        const newOrder = [];

        for (const identifier of savedOrder) {
            if (currentOrderMap.has(identifier)) {
                newOrder.push(currentOrderMap.get(identifier));
                currentOrderMap.delete(identifier);
            } else {
                if (identifier) skipped.push(identifier);
            }
        }

        for (const [, item] of currentOrderMap) {
            newOrder.push(item);
        }

        entry.order = newOrder;
    }
}

function applyPromptStatesDOM(savedPrompts, skipped) {
    const $container = jQuery(
        '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
    ).first();
    if ($container.length === 0) {
        console.warn(LOG_PREFIX, 'DOM container not found for apply.');
        return;
    }

    const currentIdentifiers = new Set();
    $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
        const id = jQuery(this).attr('data-pm-identifier') || jQuery(this).attr('data-prompt-id');
        if (id) currentIdentifiers.add(id);
    });

    for (const [identifier, enabled] of Object.entries(savedPrompts)) {
        if (!currentIdentifiers.has(identifier)) {
            skipped.push(identifier);
            continue;
        }

        const $row = $container.find(
            `[data-pm-identifier="${identifier}"], [data-prompt-id="${identifier}"]`
        ).first();
        if ($row.length === 0) continue;

        const $checkbox = $row.find('input[type="checkbox"]').first();
        if ($checkbox.length > 0) {
            if ($checkbox.prop('checked') !== enabled) {
                $checkbox.prop('checked', enabled).trigger('change');
            }
        }
    }

    console.debug(LOG_PREFIX, 'Applied prompt states via DOM fallback');
}

// ========== Prompt Manager UI Refresh ==========




