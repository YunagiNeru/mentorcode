export class EntropyCalculator {
  public shannon(input: string): number {
    if (input.length === 0) {
      return 0;
    }

    const counts = new Map<string, number>();
    for (const character of input) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    let entropy = 0;
    for (const count of counts.values()) {
      const probability = count / input.length;
      entropy -= probability * Math.log2(probability);
    }

    return entropy;
  }

  public isHighEntropyToken(input: string): boolean {
    const token = input.trim();
    if (token.length < 32 || token.length > 256) {
      return false;
    }

    if (!/^[A-Za-z0-9_./+-]+={0,2}$/.test(token)) {
      return false;
    }

    return this.shannon(token) >= 4.2;
  }
}
