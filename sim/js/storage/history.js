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

export function showParamHistoryLog(paramHistory, context) {
    const{
        floorCount,
        log,
        maxItems = 8
    } = context;

    if (!paramHistory.length) {
        log("パラメーター履歴はまだありません。");
        return;
    }

    log(`パラメーター履歴: 最新${Math.min(maxItems, paramHistory.length)}件`);

    paramHistory.slice(0, maxItems).forEach((h, i) => {
        log(
            `${i + 1}. ${h.at.slice(0, 19).replace("T", " ")} / ` +
            `階数=${h.floorCount ?? floorCount}, 人数=${h.numAgents}, 速度=${h.speed}, 速度ばらつき=${h.speedVar}%, ` +
            `開始ルール=${h.startRule}, プリセット=${h.agentPreset}, 逆最適化=${h.optimizeReverse ? "ON" : "OFF"}`
        );
    });
}