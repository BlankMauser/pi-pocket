/** Choices and thinking levels for a person's explicit model selection. */
const claude = (model) => /(?:^|\/)claude-/i.test(model.id);

/** Retire known pre-5.5 releases without concealing newer versions or future model names. */
export function selectableModels(models) {
    return models.filter((model) => {
        if (!claude(model)) {
            return true;
        }

        const version = /(?:^|\/)claude-(?:[a-z]+-)?(\d+)(?:[.-](\d+))?/i.exec(model.id);

        return (
            !version ||
            Number(version[1]) > 5 ||
            (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 5)
        );
    });
}

/** A manual Opus pick starts at medium when supported; spawning uses its own settings. */
export function pickerModelChange(model) {
    const opus = /(?:^|\/)claude-opus-/i.test(model.id);

    return {
        model: { provider: model.provider, modelId: model.id },
        ...(opus && model.levels?.includes("medium") ? { thinkingLevel: "medium" } : {}),
    };
}
