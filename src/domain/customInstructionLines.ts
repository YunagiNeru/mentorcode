export function splitCustomInstructionLines(content: string): readonly string[] {
  return content.split(/\r?\n/);
}

export function lineNumberCustomInstruction(content: string): string {
  return splitCustomInstructionLines(content)
    .map((line, index) => `L${index + 1}: ${line}`)
    .join("\n");
}
