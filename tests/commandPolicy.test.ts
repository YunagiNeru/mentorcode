import { describe, expect, it } from "vitest";
import { CommandPolicy } from "../src/domain/commands/commandPolicy";

describe("CommandPolicy", () => {
  it("creates copy-only cards for normal verification commands", () => {
    const policy = new CommandPolicy();
    const card = policy.createApprovalCard("npm test", "C:\\work\\MentorCode");

    expect(card.risk).toBe("low");
    expect(card.copyOnly).toBe(true);
    expect(card.allowedToExecute).toBe(false);
    expect(card.expectedResult).toContain("全テスト");
  });

  it("classifies destructive commands as critical", () => {
    const policy = new CommandPolicy();
    const card = policy.createApprovalCard("git reset --hard", "C:\\work\\MentorCode");

    expect(card.risk).toBe("critical");
    expect(card.allowedToExecute).toBe(false);
    expect(card.rollback.join(" ")).toContain("復元手順");
  });

  it("can mark critical commands executable when an approval flow owns execution", () => {
    const policy = new CommandPolicy();
    const card = policy.createApprovalCard("git reset --hard", "C:\\work\\MentorCode", {
      shell: "powershell",
      allowedToExecute: true
    });

    expect(card.risk).toBe("critical");
    expect(card.allowedToExecute).toBe(true);
    expect(card.copyOnly).toBe(false);
  });

  it("classifies dependency installation as high risk", () => {
    const policy = new CommandPolicy();
    const card = policy.createApprovalCard("npm install example-package", "C:\\work\\MentorCode");

    expect(card.risk).toBe("high");
    expect(card.hazards.join(" ")).toContain("依存追加");
  });
});
