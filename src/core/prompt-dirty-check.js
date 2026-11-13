/**
 * Prompt Keeper - 脏检查与状态一致性对比模块
 */

import { hasOwnSlot, isPresetNameMatch } from '../utils/format.js';
import { getPromptItemIdentifier, readPromptStates } from './prompt-reader.js';

export function findCompatiblePromptOrderEntry(currentOrder, savedEntry) {
    if (!Array.isArray(currentOrder) || !savedEntry || !Array.isArray(savedEntry.order)) return null;

    const savedIdentifiers = new Set(
        savedEntry.order.map(getPromptItemIdentifier).filter(Boolean)
    );
    if (savedIdentifiers.size === 0) return null;

    let bestEntry = null;
    let bestScore = 0;

    for (const entry of currentOrder) {
        if (!entry || !Array.isArray(entry.order)) continue;
        let score = 0;
        for (const item of entry.order) {
            const identifier = getPromptItemIdentifier(item);
            if (identifier && savedIdentifiers.has(identifier)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
        }
    }

    return bestScore > 0 ? bestEntry : null;
}

export function findPromptOrderEntryForComparison(currentOrder, savedEntry, excludedEntries) {
    const savedKey = savedEntry.character_id !== undefined ? String(savedEntry.character_id) : '__default__';
    const exact = currentOrder.find((entry) => {
        if (!entry || typeof entry !== 'object' || excludedEntries.has(entry)) return false;
        const currentKey = entry.character_id !== undefined ? String(entry.character_id) : '__default__';
        return currentKey === savedKey;
    });
    if (exact) return exact;

    return findCompatiblePromptOrderEntry(
        currentOrder.filter((entry) => !excludedEntries.has(entry)),
        savedEntry
    );
}

export function sharedIdentifierOrderEqual(savedItems, currentItems) {
    if (!Array.isArray(savedItems) || !Array.isArray(currentItems)) return false;

    const savedIdentifiers = savedItems.map(getPromptItemIdentifier).filter(Boolean);
    const currentIdentifiers = currentItems.map(getPromptItemIdentifier).filter(Boolean);
    const savedSet = new Set(savedIdentifiers);
    const currentSet = new Set(currentIdentifiers);

    const comparableSaved = savedIdentifiers.filter((identifier) => currentSet.has(identifier));
    const comparableCurrent = currentIdentifiers.filter((identifier) => savedSet.has(identifier));

    return (
        comparableSaved.length === comparableCurrent.length &&
        comparableSaved.every((identifier, index) => identifier === comparableCurrent[index])
    );
}

export function promptOrderEntryEqual(savedEntry, currentEntry) {
    if (!Array.isArray(savedEntry.order) || !Array.isArray(currentEntry.order)) {
        return savedEntry.order === currentEntry.order;
    }

    if (!sharedIdentifierOrderEqual(savedEntry.order, currentEntry.order)) return false;

    const currentEnabled = new Map();
    for (const item of currentEntry.order) {
        const identifier = getPromptItemIdentifier(item);
        if (identifier && item && typeof item === 'object') {
            currentEnabled.set(identifier, item.enabled);
        }
    }

    for (const savedItem of savedEntry.order) {
        const identifier = getPromptItemIdentifier(savedItem);
        if (!identifier || !currentEnabled.has(identifier) || !savedItem || typeof savedItem !== 'object') {
            continue;
        }
        if (savedItem.enabled !== currentEnabled.get(identifier)) return false;
    }

    return true;
}

export function promptOrderEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;

    if (a.length > 0 && b.length > 0 && typeof a[0] !== typeof b[0]) return true;

    if (a.length === 0 || b.length === 0 || typeof a[0] !== 'object') {
        return sharedIdentifierOrderEqual(a, b);
    }

    const matchedCurrentEntries = new Set();
    for (const savedEntry of a) {
        if (!savedEntry || typeof savedEntry !== 'object') continue;

        const currentEntry = findPromptOrderEntryForComparison(b, savedEntry, matchedCurrentEntries);
        if (!currentEntry) continue;

        matchedCurrentEntries.add(currentEntry);
        if (!promptOrderEntryEqual(savedEntry, currentEntry)) return false;
    }

    return true;
}

export function checkDirtyState(savedState, options = {}) {
    const allowPresetSwitch = options.allowPresetSwitch !== false;
    const currentPreset = options.currentPresetName ?? null;
    const result = {
        needsPresetSwitch: false,
        needsEntryRestore: false,
        targetPreset: null,
    };

    if (!savedState || !savedState.prompts) return result;

    if (allowPresetSwitch && savedState.presetName) {
        if (currentPreset && !isPresetNameMatch(currentPreset, savedState.presetName)) {
            result.needsPresetSwitch = true;
            result.targetPreset = savedState.presetName;
        }
    }

    if (!result.needsPresetSwitch) {
        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
                if (
                    hasOwnSlot(currentStates.prompts, identifier) &&
                    currentStates.prompts[identifier] !== enabled
                ) {
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

export function findPromptEnabledMismatches(oaiSettings, savedPrompts, currentIdentifiers) {
    const mismatched = [];
    if (!oaiSettings || !savedPrompts) return mismatched;

    if (Array.isArray(oaiSettings.prompts)) {
        for (const prompt of oaiSettings.prompts) {
            if (!prompt || !prompt.identifier || !hasOwnSlot(savedPrompts, prompt.identifier)) continue;
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
                if (!item || !item.identifier || !hasOwnSlot(savedPrompts, item.identifier)) continue;
                if (currentIdentifiers && !currentIdentifiers.has(item.identifier)) continue;
                if ((item.enabled !== false) !== savedPrompts[item.identifier]) {
                    mismatched.push(item.identifier);
                }
            }
        }
    }

    return [...new Set(mismatched)];
}

export function findSavedPromptStateMismatches(savedState) {
    if (!savedState || !savedState.prompts) return [];
    const currentStates = readPromptStates();
    if (!currentStates || !currentStates.prompts) return Object.keys(savedState.prompts);

    const mismatches = [];
    for (const [identifier, enabled] of Object.entries(savedState.prompts)) {
        if (
            hasOwnSlot(currentStates.prompts, identifier) &&
            currentStates.prompts[identifier] !== enabled
        ) {
            mismatches.push(identifier);
        }
    }

    if (
        savedState.promptOrder &&
        currentStates.promptOrder &&
        !promptOrderEqual(savedState.promptOrder, currentStates.promptOrder)
    ) {
        mismatches.push('__prompt_order__');
    }

    return mismatches;
}
