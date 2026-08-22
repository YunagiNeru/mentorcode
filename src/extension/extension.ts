import * as vscode from "vscode";
import { CustomInstructionStore } from "./customInstructionStore";
import { ServerClient } from "./serverClient";
import { MentorWebviewViewProvider } from "./webviewView";

export function activate(context: vscode.ExtensionContext): void {
  const customInstructionStore = new CustomInstructionStore();
  void customInstructionStore.initialize().catch((error) => {
    console.error("[Mentor Code Extension] custom instruction initialization failed", error);
  });
  const serverClient = new ServerClient(context);
  const mentorViewProvider = new MentorWebviewViewProvider(context, customInstructionStore);
  void mentorViewProvider.migrateConfiguredServerToken();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MentorWebviewViewProvider.viewType,
      mentorViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("mentorCode.sendShortcut") ||
        event.affectsConfiguration("mentorCode.desktopNotificationsEnabled") ||
        event.affectsConfiguration("mentorCode.activityBadgeEnabled")
      ) {
        void mentorViewProvider.postAppSettings();
      }
      if (event.affectsConfiguration("mentorCode.serverToken")) {
        void mentorViewProvider.migrateConfiguredServerToken();
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(() => {
      void mentorViewProvider.markVisibleActivityRead();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.open", async () => {
      await mentorViewProvider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.scanWorkspace", async () => {
      await mentorViewProvider.reveal();
      await mentorViewProvider.scanWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.setServerToken", async () => {
      await serverClient.setToken();
      await mentorViewProvider.postAppSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.clearServerToken", async () => {
      await serverClient.clearToken();
      await mentorViewProvider.postAppSettings();
    })
  );

  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri: (uri) => mentorViewProvider.handleMcpOAuthUri(uri)
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.setMcpServerToken", async () => {
      await mentorViewProvider.setMcpServerToken();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mentorCode.clearMcpServerToken", async () => {
      await mentorViewProvider.clearMcpServerToken();
    })
  );
}

export function deactivate(): void {
  // No background worker or external connection is kept alive in Phase1.
}
