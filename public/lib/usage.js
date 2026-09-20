export const emptyUsage = () => ({ input: 0, output: 0, calls: 0 });

export function addUsage(total, usage) {
  return {
    input: total.input + (usage?.input_tokens ?? 0),
    output: total.output + (usage?.output_tokens ?? 0),
    calls: total.calls + 1,
  };
}

export const formatTokens = (total) => `${(total.input + total.output).toLocaleString('en-US')} tokens`;
