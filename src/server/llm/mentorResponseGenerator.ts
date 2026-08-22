import type { ContextPackage, MentorRequest, MentorResponse } from "../../domain/types";
import type { McpToolContext } from "../../domain/mcp";
import type { MentorProgressReporter } from "../../domain/mentorProgress";
import { ImplementationRequirementResolver, type ImplementationRequirement } from "../../domain/mentor/implementationRequirement";
import { MentorGroundingGuard } from "./mentorGroundingGuard";
import { MentorOutputGuard, MentorOutputSafetyError } from "./mentorOutputGuard";
import { MentorResponseSchema, MentorResponseSchemaError } from "./mentorResponseSchema";

interface PendingManualImplementationFallback {
  readonly issues: readonly string[];
  readonly targetFiles: readonly string[];
}

export interface MentorResponseGenerationOptions {
  readonly source: string;
  readonly request: MentorRequest;
  readonly contextPackage: ContextPackage;
  readonly mcpContext?: McpToolContext;
  readonly maxAttempts?: number;
  readonly onProgress?: MentorProgressReporter;
  readonly fetchText: (repairFeedback: readonly string[], attempt: number) => Promise<string>;
}

export class MentorResponseGenerator {
  private readonly responseSchema = new MentorResponseSchema();
  private readonly outputGuard = new MentorOutputGuard();
  private readonly groundingGuard = new MentorGroundingGuard();
  private readonly implementationRequirements = new ImplementationRequirementResolver();

  public async generate(options: MentorResponseGenerationOptions): Promise<MentorResponse> {
    const maxAttempts = options.maxAttempts ?? 3;
    const implementationRequirement = this.implementationRequirements.resolve(options.request);
    let repairFeedback: readonly string[] = [];
    let lastIssues: readonly string[] = [];
    let pendingManualFallback: PendingManualImplementationFallback | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const text = await options.fetchText(repairFeedback, attempt);
      options.onProgress?.({ stage: "response_validating", attempt });
      try {
        const parsed = this.responseSchema.parseStrictWithDiagnostics(text, options.source);
        const groundingIssues = this.groundingGuard.validate(
          parsed.response,
          options.request,
          options.contextPackage
        );
        if (groundingIssues.length > 0) {
          throw new MentorOutputSafetyError(groundingIssues);
        }
        const planIssues = [
          ...parsed.repairIssues,
          ...this.outputGuard.validateToolPlan(parsed.response, options.contextPackage, options.mcpContext)
        ];
        if (planIssues.length > 0) {
          lastIssues = planIssues;
          if (attempt === maxAttempts) {
            if (implementationRequirement.requiresPatch) {
              return this.implementationFailureResponse(parsed.response, implementationRequirement, planIssues);
            }
            return this.omitToolCalls(parsed.response, [
              "ツール提案を有効な形式に再生成できなかったため表示しませんでした。"
            ]);
          }

          repairFeedback = this.repairFeedback(planIssues, {
            implementationPatchRequired: implementationRequirement.requiresPatch
          });
          this.reportRepair(options.onProgress, attempt + 1);
          continue;
        }

        const response = parsed.response;
        const sanitized = this.outputGuard.sanitizeToolCalls(response, options.request);
        if (sanitized.discardedPatchToolCall) {
          pendingManualFallback = {
            issues: sanitized.issues,
            targetFiles: this.manualFallbackTargetFiles(sanitized.discardedPatchTargetFiles, options.contextPackage)
          };
        }
        this.outputGuard.assertSafe(sanitized.response, options.request);

        if (sanitized.issues.length > 0) {
          lastIssues = sanitized.issues;
          if (attempt === maxAttempts) {
            if (implementationRequirement.requiresPatch) {
              return this.implementationFailureResponse(
                sanitized.response,
                implementationRequirement,
                [
                  ...sanitized.issues,
                  ...this.requiredPatchIssues(sanitized.response, implementationRequirement)
                ]
              );
            }
            if (sanitized.discardedPatchToolCall) {
              return this.manualImplementationFallback(
                sanitized.response,
                pendingManualFallback ?? {
                  issues: sanitized.issues,
                  targetFiles: this.manualFallbackTargetFiles([], options.contextPackage)
                },
                "安全検証で編集案を自動適用できないため、手動実装用の案内に切り替えました。"
              );
            }

            return sanitized.response;
          }

          repairFeedback = this.repairFeedback(sanitized.issues, {
            manualImplementationRequired: sanitized.discardedPatchToolCall,
            implementationPatchRequired: implementationRequirement.requiresPatch
          });
          this.reportRepair(options.onProgress, attempt + 1);
          continue;
        }

        const requiredPatchIssues = this.requiredPatchIssues(sanitized.response, implementationRequirement);
        if (requiredPatchIssues.length > 0) {
          lastIssues = requiredPatchIssues;
          if (attempt === maxAttempts) {
            return this.implementationFailureResponse(sanitized.response, implementationRequirement, requiredPatchIssues);
          }

          repairFeedback = this.repairFeedback(requiredPatchIssues, {
            implementationPatchRequired: true
          });
          this.reportRepair(options.onProgress, attempt + 1);
          continue;
        }

        if (pendingManualFallback && !this.hasPatchToolCall(sanitized.response)) {
          return this.manualImplementationFallback(
            sanitized.response,
            pendingManualFallback,
            "安全検証で破棄された編集案の代わりに、手動実装用の案内を表示します。"
          );
        }

        return sanitized.response;
      } catch (error) {
        const issues = this.validationIssues(error);
        if (issues.length === 0) {
          throw error;
        }

        lastIssues = issues;
        if (attempt === maxAttempts) {
          if (implementationRequirement.requiresPatch) {
            return this.implementationFailureResponse(
              {
                title: "編集案生成に失敗",
                sections: [],
                policyWarnings: []
              },
              implementationRequirement,
              issues
            );
          }
          throw new Error(
            `${options.source} mentor response failed validation after ${maxAttempts} attempts: ${issues.join("; ")}`
          );
        }

        repairFeedback = this.repairFeedback(issues, {
          implementationPatchRequired: implementationRequirement.requiresPatch
        });
        this.reportRepair(options.onProgress, attempt + 1);
      }
    }

    throw new Error(
      `${options.source} mentor response failed validation after ${maxAttempts} attempts: ${lastIssues.join("; ")}`
    );
  }

  private reportRepair(progress: MentorProgressReporter | undefined, attempt: number): void {
    progress?.({ stage: "response_repair_started", attempt });
  }

  private validationIssues(error: unknown): readonly string[] {
    if (error instanceof MentorResponseSchemaError || error instanceof MentorOutputSafetyError) {
      return error.issues;
    }

    return [];
  }

  private repairFeedback(
    issues: readonly string[],
    options: {
      readonly manualImplementationRequired?: boolean;
      readonly implementationPatchRequired?: boolean;
    } = {}
  ): readonly string[] {
    return [
      "前回応答はApp Serverで破棄されました。前回の本文を再利用せず、同じ依頼に対して新しいJSONを生成してください。",
      "JSONオブジェクトだけを返してください。Markdown、コードフェンス、説明文、途中で切れたJSONは禁止です。",
      "ローカルに適用する編集案は toolCalls[].type=\"apply_patch\" として返し、マスク済みプレースホルダは書き戻さないでください。",
      "apply_patch.fileExplanations は patch 内の各対象ファイルに対して1件ずつ返し、変更理由・目的・影響を作業内容ではなく1〜2文で書いてください。",
      "toolCalls は不要時は [] またはキー省略、必要時は apply_patch/run_command/mcp_tool オブジェクトの配列として返してください。null、空でないobject、別形式は禁止です。",
      "run_command でファイルを書き換える内容は禁止です。Set-Content、Out-File、リダイレクト、sed -i、tee などを使わず、編集は必ず apply_patch に変換してください。",
      "ビルド・テスト系 run_command は、files[] または同じ応答内の有効な apply_patch で必要なプロジェクト構成ファイルを確認できる場合だけ返してください。",
      ...(options.implementationPatchRequired
        ? [
          "この依頼は実装必須として扱われています。説明文だけ、manualImplementationだけ、run_commandだけでは不合格です。",
          "toolCalls に有効な apply_patch を少なくとも1件含めてください。必要なファイルは *** Add File で作成し、既存ファイルは *** Update File で変更してください。",
          "apply_patch の *** Add File: path では、本文の各行を必ず + で開始してください。空行も + だけの行にしてください。",
          "Add File の正しい最小例: *** Begin Patch\\n*** Add File: pom.xml\\n+<project>\\n+  <modelVersion>4.0.0</modelVersion>\\n+</project>\\n*** End Patch",
          "前回 apply_patch が無効だった修復中は run_command を返してはいけません。まず有効な apply_patch だけを返してください。",
          "不明なパスワードや接続文字列は、マスク済みプレースホルダや手動置換文字列ではなく、環境変数参照または空デフォルトにしてください。例: spring.datasource.password=${MYSQL_PASSWORD:}"
        ]
        : []),
      ...(options.manualImplementationRequired
        ? options.implementationPatchRequired
          ? [
            "安全検証で編集ツールが破棄されました。toolCallsを消さず、機密値を含まない安全な apply_patch として再生成してください。",
            "機密値、マスク済みプレースホルダ、実在の接続文字列は本文にも toolCalls にも書かないでください。"
          ]
          : [
          "安全検証で編集ツールが破棄されたため、次の応答では toolCalls を返さないでください。検証コマンドだけを返すことも禁止です。",
          "代わりに sections[] へ、対象ファイル、変更対象のキー・関数・クラス、機密値を <YOUR_SECRET> 形式に置いたソースコード例、手動反映手順を含めてください。",
          "機密値、マスク済みプレースホルダ、実在の接続文字列は本文にも toolCalls にも書かないでください。"
          ]
        : []),
      ...issues.slice(0, 6)
    ];
  }

  private omitToolCalls(response: MentorResponse, warnings: readonly string[]): MentorResponse {
    return {
      title: response.title,
      sections: response.sections,
      policyWarnings: [
        ...response.policyWarnings,
        ...warnings
      ],
      ...(response.manualImplementation ? { manualImplementation: response.manualImplementation } : {})
    };
  }

  private hasPatchToolCall(response: MentorResponse): boolean {
    return response.toolCalls?.some((toolCall) => toolCall.type === "apply_patch") ?? false;
  }

  private requiredPatchIssues(
    response: MentorResponse,
    requirement: ImplementationRequirement
  ): readonly string[] {
    if (!requirement.requiresPatch || this.hasPatchToolCall(response)) {
      return [];
    }

    return [
      requirement.reason ?? "実装必須の依頼として扱われています。",
      "有効な apply_patch toolCall がありません。説明文だけ、manualImplementationだけ、run_commandだけでは完了扱いできません。"
    ];
  }

  private implementationFailureResponse(
    response: MentorResponse,
    requirement: ImplementationRequirement,
    issues: readonly string[]
  ): MentorResponse {
    const uniqueIssues = this.uniqueStrings(issues).slice(0, 8);
    return {
      title: "編集案生成に失敗",
      sections: [
        {
          heading: "失敗理由",
          items: [
            requirement.reason ?? "実装必須の依頼として扱われています。",
            "有効な apply_patch を生成できなかったため、説明だけの応答を成功扱いしませんでした。",
            ...uniqueIssues
          ]
        },
        {
          heading: "次に必要なこと",
          items: [
            "対象ファイルを @ で明示するか、同じ依頼を再送してください。",
            "DBパスワードなどの秘密値は実値ではなく環境変数参照にする必要があります。",
            "この応答ではローカルファイルへの編集案は表示していません。"
          ]
        }
      ],
      policyWarnings: this.uniqueStrings([
        ...response.policyWarnings,
        "実装必須の依頼で有効な apply_patch が生成されなかったため、説明だけの応答を破棄しました。",
        "ツール提案を有効な形式に再生成できなかったため表示しませんでした。"
      ])
    };
  }

  private manualFallbackTargetFiles(
    targetFiles: readonly string[],
    contextPackage: ContextPackage
  ): readonly string[] {
    const unique = this.uniqueStrings(targetFiles);
    if (unique.length > 0) {
      return unique.slice(0, 8);
    }

    return contextPackage.files.map((file) => file.path).slice(0, 8);
  }

  private manualImplementationFallback(
    response: MentorResponse,
    fallback: PendingManualImplementationFallback,
    reason: string
  ): MentorResponse {
    const targetFiles = this.uniqueStrings(fallback.targetFiles).slice(0, 8);
    return {
      title: response.title,
      sections: this.manualImplementationSections(response.sections, targetFiles),
      policyWarnings: this.uniqueStrings([
        ...response.policyWarnings,
        "一部のツール提案は安全検証を通過しなかったため破棄しました。",
        "編集案を自動適用できないため、手動実装用の修正イメージを提示します。"
      ]),
      manualImplementation: {
        required: true,
        reason,
        targetFiles
      }
    };
  }

  private manualImplementationSections(
    sections: MentorResponse["sections"],
    targetFiles: readonly string[]
  ): MentorResponse["sections"] {
    return [
      ...sections,
      {
        heading: "手動実装が必要な理由",
        items: [
          "安全検証により自動適用用の編集案を破棄しました。機密値を含む可能性がある変更は、外部LLMの編集ツールではなくユーザーがローカルで手動反映してください。",
          targetFiles.length > 0
            ? `対象ファイル: ${targetFiles.join(", ")}`
            : "対象ファイルは現在のコンテキストから明確に特定できません。関連する設定ファイルまたは修正対象ファイルを開いて確認してください。"
        ]
      },
      {
        heading: "修正イメージ",
        items: [
          [
            "設定ファイルの場合は既存キー名を維持し、値だけをローカルの実値に置き換えてください。",
            "```properties",
            "example.connection.user=<YOUR_USER_NAME>",
            "example.connection.password=<YOUR_PASSWORD>",
            "example.connection.url=<YOUR_CONNECTION_URL>",
            "```"
          ].join("\n"),
          [
            "ソースコードの場合は機密値を直書きせず、環境変数またはローカル設定から読む形にしてください。",
            "```ts",
            "const connectionUser = process.env.APP_CONNECTION_USER ?? \"<LOCAL_USER_NAME>\";",
            "const connectionPassword = process.env.APP_CONNECTION_PASSWORD ?? \"<LOCAL_PASSWORD>\";",
            "```"
          ].join("\n")
        ]
      }
    ];
  }

  private uniqueStrings(values: readonly string[]): readonly string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
  }
}
