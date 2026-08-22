import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface RpcResponse { readonly id?: number; readonly result?: unknown; readonly error?: { message?: string }; }

function defaultCodexCommand(): { executable: string; prefix: string[] } {
  if (process.platform !== "win32") return { executable: "codex", prefix: [] };
  const script = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(script) ? { executable: process.execPath, prefix: [script] } : { executable: "codex.exe", prefix: [] };
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly command: { executable: string; prefix: string[] };
  public constructor(command = defaultCodexCommand(), private readonly expectedVersion = "0.144.6") { this.command = command; }

  public inspect(): { installed: boolean; version?: string; compatible: boolean } {
    const result = spawnSync(this.command.executable, [...this.command.prefix, "--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const output = result.status === 0 ? result.stdout.trim() : "";
    const version = output.match(/(\d+\.\d+\.\d+)/)?.[1];
    return { installed: Boolean(version), ...(version ? { version } : {}), compatible: version === this.expectedVersion };
  }

  public async connect(): Promise<void> {
    if (this.process) return;
    const inspection = this.inspect();
    if (!inspection.compatible) throw new Error(`Codex CLI ${this.expectedVersion} is required; detected ${inspection.version ?? "none"}.`);
    const child = spawn(this.command.executable, [...this.command.prefix, "app-server"], { stdio: "pipe", windowsHide: true, shell: false });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", line => this.receive(line));
    child.on("exit", () => { this.process = undefined; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex app-server stopped.")); } this.pending.clear(); });
    await this.call("initialize", { clientInfo: { name: "mentor-code", version: "0.1.5" }, capabilities: {} });
    this.notify("initialized", {});
  }

  public async account(): Promise<unknown> { await this.connect(); return this.call("account/read", {}); }
  public async rateLimits(): Promise<unknown> { await this.connect(); return this.call("account/rateLimits/read", {}); }
  public async startDeviceLogin(): Promise<unknown> { await this.connect(); return this.call("account/login/start", { type: "chatgptDeviceCode" }); }
  public stop(): void { this.process?.kill(); this.process = undefined; }

  private call(method: string, params: unknown): Promise<unknown> {
    if (!this.process) return Promise.reject(new Error("Codex app-server is not connected."));
    const id = ++this.sequence;
    this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => { const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex request timed out: ${method}`));},15000); this.pending.set(id,{resolve,reject,timer}); });
  }
  private notify(method: string, params: unknown): void { this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  private receive(line: string): void {
    let message: RpcResponse; try { message=JSON.parse(line) as RpcResponse; } catch { return; }
    if (message.id === undefined) return; const entry=this.pending.get(message.id); if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message ?? "Codex request failed.")); else entry.resolve(message.result);
  }
}
