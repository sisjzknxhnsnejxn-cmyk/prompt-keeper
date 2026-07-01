// ========== Prompt Keeper World Book State ==========

function wbkArrayFromMaybe(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
    return [];
}

function wbkPushWorldBookName(names, value) {
    const normalized = String(value || '').trim();
    if (normalized) names.push(normalized);
}

function wbkCollectWorldBookNamesFromValue(value, names, visited = new Set()) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
        for (const item of wbkArrayFromMaybe(String(value))) wbkPushWorldBookName(names, item);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) wbkCollectWorldBookNamesFromValue(item, names, visited);
        return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    for (const key of ['name', 'worldName', 'world_name', 'world', 'book', 'bookName', 'filename', 'file']) {
        if (typeof value[key] === 'string' || typeof value[key] === 'number') wbkPushWorldBookName(names, value[key]);
    }

    for (const key of ['value', 'label']) {
        if (typeof value[key] === 'string' && (value.selected === true || value.enabled === true || value.checked === true)) {
            wbkPushWorldBookName(names, value[key]);
        }
    }
}

function wbkCollectSelectedWorldBooksFromObject(source, names, visited = new Set(), depth = 0) {
    if (!source || typeof source !== 'object' || visited.has(source) || depth > 3) return;
    visited.add(source);

    const selectionKeys = [
        'selected_world_info', 'selectedWorldInfo', 'selectedWorldInfos', 'selectedWorldBooks',
        'globalSelect', 'global_select', 'globalWorldInfo', 'globalWorldInfos',
        'globalLore', 'global_lore', 'chatLore', 'chat_lore', 'characterLore', 'character_lore',
        'charLore', 'char_lore', 'personaLore', 'persona_lore', 'characterBook', 'character_book',
        'personaBook', 'persona_book',
    ];

    for (const key of selectionKeys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            wbkCollectWorldBookNamesFromValue(source[key], names, visited);
        }
    }

    const nestedKeys = [
        'worldInfoSettings', 'world_info_settings', 'settings',
        'chatMetadata', 'character', 'characters', 'this_chid', 'groups', 'extensionSettings',
    ];

    for (const key of nestedKeys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            wbkCollectSelectedWorldBooksFromObject(source[key], names, visited, depth + 1);
        }
    }
}

function wbkGetWorldInfoSelect() {
    const $ = window.jQuery || window.$;
    if (typeof $ !== 'function') return null;
    return $('#world_info');
}

function wbkAsJQuery(element) {
    const $ = window.jQuery || window.$;
    return typeof $ === 'function' ? $(element) : null;
}

function wbkGetWorldBookNameFromOption($option, fallbackNames) {
    if (!$option || $option.length === 0) return '';
    const value = String($option.val() ?? '').trim();
    const index = Number(value);
    if (Number.isInteger(index) && fallbackNames[index]) return fallbackNames[index];
    return String($option.text() || $option.attr('label') || value || '').trim();
}

function wbkGetWorldBookNamesFromSelect() {
    const $select = wbkGetWorldInfoSelect();
    if (!$select || $select.length === 0) return [];

    const fallbackNames = wbkUniqueStrings([
        ...wbkArrayFromMaybe(wbkGetCtx().world_names),
        ...wbkArrayFromMaybe(window.world_names),
    ]);
    const names = [];
    $select.find('option').each(function () {
        wbkPushWorldBookName(names, wbkGetWorldBookNameFromOption(wbkAsJQuery(this), fallbackNames));
    });
    return wbkUniqueStrings(names);
}

function wbkGetSelectedWorldBooksFromSelect() {
    const $select = wbkGetWorldInfoSelect();
    if (!$select || $select.length === 0) return null;

    const fallbackNames = wbkGetWorldBookNamesFromSelect();
    const names = [];
    $select.find('option:selected').each(function () {
        wbkPushWorldBookName(names, wbkGetWorldBookNameFromOption(wbkAsJQuery(this), fallbackNames));
    });
    return wbkUniqueStrings(names);
}

function wbkGetPersistedGlobalWorldBooks() {
    const ctx = wbkGetCtx();
    const names = [];
    const sources = [
        ctx.world_info,
        ctx.worldInfo,
        window.world_info,
        window.worldInfo,
        window.world_info_settings,
        window.worldInfoSettings,
    ];

    for (const source of sources) {
        if (!source || typeof source !== 'object') continue;
        wbkCollectWorldBookNamesFromValue(source.globalSelect, names);
        wbkCollectWorldBookNamesFromValue(source.global_select, names);
        wbkCollectWorldBookNamesFromValue(source.globalWorldInfo, names);
        wbkCollectWorldBookNamesFromValue(source.globalWorldInfos, names);
    }
    return wbkUniqueStrings(names);
}

function wbkGetSelectedWorldBooks() {
    const ctx = wbkGetCtx();
    const names = [];
    const selectedFromUi = wbkGetSelectedWorldBooksFromSelect();
    if (selectedFromUi !== null) return selectedFromUi;

    names.push(...wbkGetPersistedGlobalWorldBooks());

    const candidates = [
        ctx.selected_world_info,
        window.selected_world_info,
    ];

    for (const candidate of candidates) {
        wbkCollectWorldBookNamesFromValue(candidate, names);
    }

    // Only inspect objects that represent current chat/runtime selection state.
    // Do not scan world_info/worldInfo/world_info_data here: those objects can contain
    // every known world book, which would make "selected books" indistinguishable from
    // "all known books" and make captureAllKnownBooks behave like it is always enabled.
    for (const source of [ctx, window.world_info_settings, window.worldInfoSettings, ctx.chatMetadata]) {
        wbkCollectSelectedWorldBooksFromObject(source, names);
    }

    return wbkUniqueStrings(names);
}

function wbkAreStringArraysEqual(a, b) {
    const left = wbkUniqueStrings(a);
    const right = wbkUniqueStrings(b);
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

function wbkGetAllWorldBookNames() {
    const ctx = wbkGetCtx();
    const names = [];
    names.push(...wbkGetWorldBookNamesFromSelect());
    names.push(...wbkArrayFromMaybe(ctx.world_names));
    names.push(...wbkArrayFromMaybe(window.world_names));
    names.push(...wbkGetSelectedWorldBooks());

    for (const source of [window.world_info, window.worldInfo, window.world_info_data]) {
        if (!source || typeof source !== 'object') continue;
        if (source.name) names.push(source.name);
        if (source.worldName) names.push(source.worldName);
        if (source.worlds && typeof source.worlds === 'object') names.push(...Object.keys(source.worlds));
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && (value.entries || value.name || value.worldName)) names.push(key);
        }
    }

    return wbkUniqueStrings(names);
}

function wbkSetArrayTarget(target, key, names) {
    if (!target || !(key in target)) return false;
    if (wbkAreStringArraysEqual(target[key], names)) return false;
    if (Array.isArray(target[key])) target[key].splice(0, target[key].length, ...names);
    else target[key] = names.slice();
    return true;
}

function wbkSetGlobalSelectTarget(target, names) {
    if (!target || typeof target !== 'object') return false;
    if (!target.globalSelect) {
        target.globalSelect = [];
    }
    return wbkSetArrayTarget(target, 'globalSelect', names);
}

function wbkSetSelectedWorldBooksInSelect(names) {
    const normalized = wbkUniqueStrings(names);
    const $select = wbkGetWorldInfoSelect();
    if (!$select || $select.length === 0) return false;

    const fallbackNames = wbkGetWorldBookNamesFromSelect();
    const targetLower = new Set(normalized.map(name => name.toLowerCase()));
    const selectedValues = [];

    $select.find('option').each(function () {
        const $option = wbkAsJQuery(this);
        const bookName = wbkGetWorldBookNameFromOption($option, fallbackNames);
        if (bookName && targetLower.has(bookName.toLowerCase())) {
            selectedValues.push(String($option.val()));
        }
    });

    const currentValues = wbkArrayFromMaybe($select.val()).map(value => String(value));
    if (wbkAreStringArraysEqual(currentValues, selectedValues)) return false;
    $select.val(selectedValues).trigger('change');
    return true;
}

function wbkSetSelectedWorldBooks(names) {
    const normalized = wbkUniqueStrings(names);
    const ctx = wbkGetCtx();
    let changed = false;

    changed = wbkSetSelectedWorldBooksInSelect(normalized) || changed;
    changed = wbkSetGlobalSelectTarget(ctx.world_info, normalized) || changed;
    changed = wbkSetGlobalSelectTarget(ctx.worldInfo, normalized) || changed;
    changed = wbkSetGlobalSelectTarget(window.world_info, normalized) || changed;
    changed = wbkSetGlobalSelectTarget(window.worldInfo, normalized) || changed;
    changed = wbkSetGlobalSelectTarget(window.world_info_settings, normalized) || changed;
    changed = wbkSetGlobalSelectTarget(window.worldInfoSettings, normalized) || changed;
    changed = wbkSetArrayTarget(ctx, 'selected_world_info', normalized) || changed;
    changed = wbkSetArrayTarget(window, 'selected_world_info', normalized) || changed;
    changed = wbkSetArrayTarget(ctx, 'world_names', normalized) || changed;
    changed = wbkSetArrayTarget(window, 'world_names', normalized) || changed;

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.event_types || ctx.eventTypes || {};
    if (eventSource && typeof eventSource.emit === 'function') {
        for (const eventName of ['WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'SETTINGS_UPDATED']) {
            if (eventTypes[eventName]) eventSource.emit(eventTypes[eventName]);
        }
    }
    wbkSaveSettings();
    return changed;
}

function wbkGetWorldBookData(bookName) {
    for (const source of [window.world_info, window.worldInfo, window.world_info_data]) {
        if (!source || typeof source !== 'object') continue;
        if (source[bookName]) return source[bookName];
        if (source.worlds && source.worlds[bookName]) return source.worlds[bookName];
        if ((source.name === bookName || source.worldName === bookName) && source.entries) return source;
    }
    return null;
}

function wbkGetEntryCollection(bookData) {
    if (!bookData || typeof bookData !== 'object') return null;
    if (bookData.entries) return bookData.entries;
    if (bookData.data && bookData.data.entries) return bookData.data.entries;
    if (bookData.world_info && bookData.world_info.entries) return bookData.world_info.entries;
    return null;
}

function wbkGetEntryPairs(bookData) {
    const entries = wbkGetEntryCollection(bookData);
    if (!entries) return [];
    if (Array.isArray(entries)) return entries.map((entry, index) => [String(entry && (entry.uid ?? entry.id ?? index)), entry]);
    if (typeof entries === 'object') return Object.entries(entries);
    return [];
}

function wbkGetEntryOrder(entry, fallbackIndex) {
    if (!entry || typeof entry !== 'object') return fallbackIndex;
    const candidates = [entry.order, entry.position, entry.sort_order, entry.sortOrder];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value)) return value;
    }
    return fallbackIndex;
}

function wbkApplyEntryOrder(bookData, savedEntries) {
    const entries = wbkGetEntryCollection(bookData);
    if (!entries || !savedEntries || typeof savedEntries !== 'object') return false;

    const savedOrderByUid = new Map();
    for (const savedEntry of Object.values(savedEntries)) {
        if (!savedEntry || savedEntry.uid === undefined || savedEntry.order === undefined) continue;
        const order = Number(savedEntry.order);
        if (Number.isFinite(order)) savedOrderByUid.set(String(savedEntry.uid), order);
    }
    if (savedOrderByUid.size === 0) return false;

    if (Array.isArray(entries)) {
        const indexed = entries.map((entry, index) => {
            const uid = wbkGetEntryIdentity(entry, index);
            return { entry, index, order: savedOrderByUid.has(uid) ? savedOrderByUid.get(uid) : index + entries.length };
        });
        indexed.sort((a, b) => (a.order - b.order) || (a.index - b.index));
        entries.splice(0, entries.length, ...indexed.map(item => item.entry));
        return true;
    }

    let changed = false;
    for (const [fallbackKey, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const uid = wbkGetEntryIdentity(entry, fallbackKey);
        if (!savedOrderByUid.has(uid)) continue;
        const order = savedOrderByUid.get(uid);
        if (entry.order !== order) {
            entry.order = order;
            changed = true;
        }
    }
    return changed;
}

function wbkGetEntryIdentity(entry, fallbackKey) {
    if (!entry || typeof entry !== 'object') return String(fallbackKey);
    return String(entry.uid ?? entry.id ?? fallbackKey);
}

function wbkGetEntryLabel(entry, fallbackKey) {
    if (!entry || typeof entry !== 'object') return String(fallbackKey);
    const key = Array.isArray(entry.key) ? entry.key.join(', ') : entry.key;
    return String(entry.comment || entry.memo || key || entry.uid || entry.id || fallbackKey);
}

function wbkGetEntryComment(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.comment || entry.memo || '');
}

function wbkGetEntryKeySignature(entry) {
    if (!entry || typeof entry !== 'object') return '';
    const keys = Array.isArray(entry.key) ? entry.key : (entry.key ? [entry.key] : []);
    return wbkUniqueStrings(keys).join('\n').toLowerCase();
}

function wbkHashString(value) {
    const text = String(value || '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return String(hash);
}

function wbkGetEntryContentHash(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return wbkHashString(entry.content || entry.contentText || entry.text || '');
}

function wbkReadWorldBookState() {
    const settings = wbkLoadSettings();
    const selectedBooks = wbkGetSelectedWorldBooks();
    const targetBooks = settings.captureAllKnownBooks ? wbkGetAllWorldBookNames() : selectedBooks;
    const books = {};

    if (settings.manageEntryStates !== false) {
        for (const bookName of targetBooks) {
            const bookData = wbkGetWorldBookData(bookName);
            const entries = {};
            const entryPairs = wbkGetEntryPairs(bookData);
            for (let index = 0; index < entryPairs.length; index++) {
                const [fallbackKey, entry] = entryPairs[index];
                if (!entry || typeof entry !== 'object') continue;
                const id = wbkGetEntryIdentity(entry, fallbackKey);
                entries[id] = {
                    uid: id,
                    label: wbkGetEntryLabel(entry, fallbackKey),
                    comment: wbkGetEntryComment(entry),
                    keySignature: wbkGetEntryKeySignature(entry),
                    contentHash: wbkGetEntryContentHash(entry),
                    disable: entry.disable === true,
                    constant: entry.constant === true,
                    selective: entry.selective === true,
                    order: wbkGetEntryOrder(entry, index),
                };
            }
            books[bookName] = { entries };
        }
    }

    return { selectedBooks, books, capturedAt: Date.now() };
}

function wbkFindEntryBySavedState(entryPairs, savedEntry) {
    for (const [fallbackKey, entry] of entryPairs) {
        if (entry && typeof entry === 'object' && wbkGetEntryIdentity(entry, fallbackKey) === String(savedEntry.uid)) return entry;
    }
    const candidates = entryPairs
        .map(([fallbackKey, entry]) => ({ fallbackKey, entry }))
        .filter(({ fallbackKey, entry }) => entry && typeof entry === 'object' && wbkGetEntryLabel(entry, fallbackKey) === savedEntry.label);
    if (candidates.length === 1) return candidates[0].entry;
    if (candidates.length === 0) return null;

    const strongerMatches = candidates.filter(({ entry }) => {
        const commentMatches = savedEntry.comment && wbkGetEntryComment(entry) === savedEntry.comment;
        const keyMatches = savedEntry.keySignature && wbkGetEntryKeySignature(entry) === savedEntry.keySignature;
        const contentMatches = savedEntry.contentHash && wbkGetEntryContentHash(entry) === savedEntry.contentHash;
        return commentMatches || keyMatches || contentMatches;
    });

    return strongerMatches.length === 1 ? strongerMatches[0].entry : null;
}

function wbkGetSelectedBooksRestorePlan(savedBooks, settings) {
    const mode = WBK_SELECTED_BOOKS_RESTORE_MODES.includes(settings.selectedBooksRestoreMode)
        ? settings.selectedBooksRestoreMode
        : WBK_DEFAULT_SETTINGS.selectedBooksRestoreMode;
    const saved = wbkUniqueStrings(savedBooks);
    const current = wbkGetSelectedWorldBooks();

    if (settings.manageSelectedBooks === false) return { mode: 'disabled', current, target: current, shouldApply: false };
    if (mode === 'skip') return { mode, current, target: current, shouldApply: false };
    if (mode === 'replace') return { mode, current, target: saved, shouldApply: true };
    return { mode: 'merge', current, target: wbkUniqueStrings(current.concat(saved)), shouldApply: true };
}

function wbkApplyWorldBookState(state) {
    if (!state || typeof state !== 'object') return { applied: 0, skipped: 0, selectedChanged: false, selectedMode: 'none' };
    const settings = wbkLoadSettings();
    let selectedChanged = false;
    let selectedMode = 'none';
    let applied = 0;
    let skipped = 0;

    if (Array.isArray(state.selectedBooks)) {
        const plan = wbkGetSelectedBooksRestorePlan(state.selectedBooks, settings);
        selectedMode = plan.mode;
        if (plan.shouldApply) selectedChanged = wbkSetSelectedWorldBooks(plan.target);
    }

    if (settings.manageEntryStates !== false && state.books && typeof state.books === 'object') {
        for (const [bookName, bookState] of Object.entries(state.books)) {
            const bookData = wbkGetWorldBookData(bookName);
            const entryPairs = wbkGetEntryPairs(bookData);
            if (entryPairs.length === 0) {
                skipped += Object.keys((bookState && bookState.entries) || {}).length;
                continue;
            }
            if (settings.manageEntryOrder !== false && bookState && bookState.entries) {
                wbkApplyEntryOrder(bookData, bookState.entries);
            }
            for (const savedEntry of Object.values((bookState && bookState.entries) || {})) {
                const entry = wbkFindEntryBySavedState(entryPairs, savedEntry);
                if (!entry) {
                    skipped++;
                    continue;
                }
                entry.disable = savedEntry.disable === true;
                if ('constant' in entry || savedEntry.constant === true) entry.constant = savedEntry.constant === true;
                if ('selective' in entry || savedEntry.selective === true) entry.selective = savedEntry.selective === true;
                if (settings.manageEntryOrder !== false && savedEntry.order !== undefined) {
                    const order = Number(savedEntry.order);
                    if (Number.isFinite(order)) entry.order = order;
                }
                applied++;
            }
        }
    }

    wbkSaveSettings();
    return { applied, skipped, selectedChanged, selectedMode };
}
