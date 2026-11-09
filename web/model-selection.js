/** Choices and thinking levels for a person's explicit model selection. */
const claude = (model) => /(?:^|\/)claude-/i.test(model.id);

/** Retire old releases by family: Fable/Mythos 5.2 and Opus/Sonnet/Haiku 5.5 remain current. */
export function selectableModels(models) {
    return models.filter((model) => {
        if (!claude(model)) {
            return true;
        }

        const version = /(?:^|\/)claude-(?:[a-z]+-)?(\d+)(?:[.-](\d+))?/i.exec(model.id);

        const minimumMinor = /(?:^|\/)claude-(?:fable|mythos)-/i.test(model.id) ? 2 : 5;

        return (
            !version ||
            Number(version[1]) > 5 ||
            (Number(version[1]) === 5 && Number(version[2] ?? 0) >= minimumMinor)
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
