export function pushParamHistoryEntry(paramHistory, snapshot, maxLength = 120) {
    const entry = {
        at: new Date().toISOString(),
        ...snapshot};

        paramHistory.unshift(entry);

        if (paramHistory.length > maxLength) {
            paramHistory.length = maxLength;
        }

        return entry;
}