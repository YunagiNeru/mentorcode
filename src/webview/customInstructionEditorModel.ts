export const DEFAULT_CUSTOM_INSTRUCTION_MAX_BYTES = 32 * 1024;

export interface CustomInstructionSnapshot {
  readonly content: string;
  readonly revision: string;
  readonly byteLength: number;
  readonly filePath: string;
  readonly directoryPath: string;
}

export type CustomInstructionSaveStatus =
  | "loading"
  | "saved"
  | "pending"
  | "saving"
  | "conflict"
  | "too_large"
  | "error";

export interface CustomInstructionSaveRequest {
  readonly content: string;
  readonly expectedRevision: string;
}

export class CustomInstructionEditorModel {
  public draft = "";
  public revision = "";
  public byteLength = 0;
  public filePath = "";
  public directoryPath = "";
  public status: CustomInstructionSaveStatus = "loading";
  public errorMessage = "";
  public conflictSnapshot: CustomInstructionSnapshot | undefined;
  private saveInFlight = false;

  public constructor(public readonly maxBytes = DEFAULT_CUSTOM_INSTRUCTION_MAX_BYTES) {}

  public load(snapshot: CustomInstructionSnapshot): void {
    this.applySnapshot(snapshot);
    this.status = "saved";
    this.errorMessage = "";
    this.conflictSnapshot = undefined;
    this.saveInFlight = false;
  }

  public edit(content: string): void {
    this.draft = content;
    this.byteLength = new TextEncoder().encode(content).byteLength;
    this.errorMessage = "";
    this.conflictSnapshot = undefined;
    this.status = this.byteLength > this.maxBytes ? "too_large" : "pending";
  }

  public beginSave(): CustomInstructionSaveRequest | undefined {
    if (this.saveInFlight || this.status !== "pending" || !this.revision) {
      return undefined;
    }

    this.saveInFlight = true;
    this.status = "saving";
    return {
      content: this.draft,
      expectedRevision: this.revision
    };
  }

  public applySaved(snapshot: CustomInstructionSnapshot): void {
    this.saveInFlight = false;
    this.revision = snapshot.revision;
    this.filePath = snapshot.filePath;
    this.directoryPath = snapshot.directoryPath;
    if (this.draft === snapshot.content) {
      this.byteLength = snapshot.byteLength;
      this.status = "saved";
      this.errorMessage = "";
      return;
    }

    this.status = this.byteLength > this.maxBytes ? "too_large" : "pending";
  }

  public failSave(message: string, conflictSnapshot?: CustomInstructionSnapshot): void {
    this.saveInFlight = false;
    this.errorMessage = message;
    this.conflictSnapshot = conflictSnapshot;
    this.status = conflictSnapshot ? "conflict" : "error";
  }

  public reloadConflict(): void {
    if (!this.conflictSnapshot) {
      return;
    }

    this.load(this.conflictSnapshot);
  }

  public prepareConflictOverwrite(): void {
    if (!this.conflictSnapshot) {
      return;
    }

    this.revision = this.conflictSnapshot.revision;
    this.conflictSnapshot = undefined;
    this.errorMessage = "";
    this.status = this.byteLength > this.maxBytes ? "too_large" : "pending";
  }

  private applySnapshot(snapshot: CustomInstructionSnapshot): void {
    this.draft = snapshot.content;
    this.revision = snapshot.revision;
    this.byteLength = snapshot.byteLength;
    this.filePath = snapshot.filePath;
    this.directoryPath = snapshot.directoryPath;
  }
}
