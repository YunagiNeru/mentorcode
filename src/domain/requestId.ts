import { randomBytes } from "node:crypto";

const REQUEST_ID_ALPHABET = "abcdefghijklmnop";
const REQUEST_ID_PATTERN = /^req_[a-p]{32}$/;

export function createMentorRequestId(): string {
  const hex = randomBytes(16).toString("hex");
  const encoded = [...hex]
    .map((character) => REQUEST_ID_ALPHABET[Number.parseInt(character, 16)])
    .join("");
  return `req_${encoded}`;
}

export function isMentorRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}
