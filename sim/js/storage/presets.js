export function loadPresetStore(storageKey) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    } 
}

export function savePresetStore(storageKey, store) {
    localStorage.setItem(storageKey, JSON.stringify(store));
}