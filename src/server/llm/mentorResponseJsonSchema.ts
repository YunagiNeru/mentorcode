const applyPatchToolSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["apply_patch"] },
    intent: { type: "string" },
    patch: { type: "string" },
    fileExplanations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          explanation: { type: "string" }
        },
        required: ["path", "explanation"]
      }
    }
  },
  required: ["type", "intent", "patch", "fileExplanations"]
} as const;

const runCommandToolSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["run_command"] },
    shell: { type: "string", enum: ["powershell", "cmd", "bash"] },
    command: { type: "string" },
    workingDirectory: { type: "string" },
    meaning: { type: "string" },
    expectedResult: { type: "string" }
  },
  required: ["type", "shell", "command", "workingDirectory", "meaning", "expectedResult"]
} as const;

const mcpToolSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["mcp_tool"] },
    serverId: { type: "string" },
    toolName: { type: "string" },
    arguments: { type: "object" },
    intent: { type: "string" },
    expectedResult: { type: "string" }
  },
  required: ["type", "serverId", "toolName", "arguments", "intent", "expectedResult"]
} as const;

export const MENTOR_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          items: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["heading", "items"]
      }
    },
    policyWarnings: {
      type: "array",
      items: { type: "string" }
    },
    toolCalls: {
      type: "array",
      items: {
        anyOf: [applyPatchToolSchema, runCommandToolSchema, mcpToolSchema]
      }
    },
    manualImplementation: {
      type: "object",
      properties: {
        required: { type: "boolean", enum: [true] },
        reason: { type: "string" },
        targetFiles: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["required", "reason", "targetFiles"]
    }
  },
  required: ["title", "sections", "policyWarnings"]
} as const;
