import { ApplyPatchParser } from "./applyPatch";
import type {
  MentorCommandToolCall,
  MentorMcpToolCall,
  MentorPatchToolCall,
  MentorPatchPreview,
  MentorResponse,
  MentorToolActionKind,
  MentorWorkspaceOperation
} from "../types";

const parser = new ApplyPatchParser();

export function patchToolCall(response: MentorResponse): MentorPatchToolCall | undefined {
  return response.toolCalls?.find((toolCall): toolCall is MentorPatchToolCall => toolCall.type === "apply_patch");
}

export function commandToolCall(response: MentorResponse): MentorCommandToolCall | undefined {
  return response.toolCalls?.find((toolCall): toolCall is MentorCommandToolCall => toolCall.type === "run_command");
}

export function mcpToolCall(response: MentorResponse): MentorMcpToolCall | undefined {
  return response.toolCalls?.find((toolCall): toolCall is MentorMcpToolCall => toolCall.type === "mcp_tool");
}

export function manualImplementationTargetPaths(response: MentorResponse): readonly string[] {
  return response.manualImplementation?.targetFiles ?? [];
}

export function requiresManualImplementation(response: MentorResponse): boolean {
  return response.manualImplementation?.required === true;
}

export function implementationToolActionKinds(response: MentorResponse): readonly MentorToolActionKind[] {
  const actions: MentorToolActionKind[] = [];
  if (patchToolCall(response) || requiresManualImplementation(response)) {
    actions.push("applyPatch");
  }
  if (commandToolCall(response)) {
    actions.push("runCommand");
  }
  if (mcpToolCall(response)) {
    actions.push("mcpTool");
  }
  return actions;
}

export function patchToolCallToEditPreview(toolCall: MentorPatchToolCall): MentorPatchPreview {
  return {
    mode: "workspace",
    intent: toolCall.intent,
    operations: patchPreviewOperations(toolCall)
  };
}

export function patchToolCallTargetPaths(toolCall: MentorPatchToolCall): readonly string[] {
  const paths = new Set<string>();
  try {
    for (const action of parser.parse(toolCall.patch).actions) {
      paths.add(action.path);
      if (action.type === "update" && action.moveTo) {
        paths.add(action.moveTo);
      }
    }
  } catch {
    return [];
  }
  return [...paths];
}

export function commandToolCallTargetPaths(toolCall: MentorCommandToolCall): readonly string[] {
  return [toolCall.workingDirectory];
}

function patchPreviewOperations(toolCall: MentorPatchToolCall): readonly MentorWorkspaceOperation[] {
  try {
    return parser.parse(toolCall.patch).actions.map((action): MentorWorkspaceOperation => {
      const explanation = patchFileExplanation(toolCall, action.path);
      switch (action.type) {
        case "add":
          return {
            type: "createFile",
            path: action.path,
            content: action.content,
            explanation
          };
        case "delete":
          return {
            type: "deletePath",
            path: action.path,
            recursive: false,
            explanation
          };
        case "update":
          return {
            type: "replaceInFile",
            path: action.path,
            originalText: action.hunks.map((hunk) => hunk.lines
              .filter((line) => line.kind !== "add")
              .map((line) => line.text)
              .join("\n")).join("\n...\n"),
            replacementText: action.hunks.map((hunk) => hunk.lines
              .filter((line) => line.kind !== "remove")
              .map((line) => line.text)
              .join("\n")).join("\n...\n"),
            explanation
          };
      }
    });
  } catch {
    return [
      {
        type: "replaceInFile",
        path: "apply_patch",
        originalText: "",
        replacementText: toolCall.patch,
        explanation: "apply_patch のプレビュー解析に失敗しました。適用時に構文検証します。"
      }
    ];
  }
}

function patchFileExplanation(toolCall: MentorPatchToolCall, path: string): string {
  const normalizedPath = normalizePath(path);
  return toolCall.fileExplanations
    ?.find((item) => normalizePath(item.path) === normalizedPath)
    ?.explanation
    ?? toolCall.intent;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
