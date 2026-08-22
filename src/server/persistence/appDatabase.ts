import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createToken, hashPassword, hashToken, verifyPassword } from "../security/adminCredentials";

const SCHEMA_VERSION = 2;

export interface BootstrapResult { readonly created: boolean; readonly legacyTokenMigrated: boolean; }
export interface AdminSession { readonly adminId: string; readonly csrfHash: string; }

export class AppDatabase {
  private readonly db: Database.Database;

  public constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  public close(): void { this.db.close(); }
  public async backup(path: string): Promise<void> { await this.db.backup(path); }

  public bootstrap(file: string | undefined, legacyToken: string | undefined): BootstrapResult {
    const count = (this.db.prepare("SELECT COUNT(*) count FROM admin_account").get() as { count: number }).count;
    if (count > 0) {
      if (file) throw new Error("Remove MENTOR_ADMIN_BOOTSTRAP_FILE after the first administrator is created.");
      return { created: false, legacyTokenMigrated: false };
    }
    if (!file) throw new Error("MENTOR_ADMIN_BOOTSTRAP_FILE is required until the first administrator is created.");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { adminId?: unknown; password?: unknown };
    if (typeof parsed.adminId !== "string" || !/^[a-zA-Z0-9._-]{3,64}$/.test(parsed.adminId)) throw new Error("Bootstrap adminId is invalid.");
    if (typeof parsed.password !== "string" || parsed.password.length < 12) throw new Error("Bootstrap password must contain at least 12 characters.");
    const adminId = parsed.adminId; const password = parsed.password;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO admin_account (admin_id,password_hash,created_at,updated_at) VALUES (?,?,?,?)").run(adminId, hashPassword(password), now, now);
      if (legacyToken) this.insertUserWithToken("legacy", "Migrated server token", legacyToken, now);
      this.audit(adminId, "bootstrap", "admin", "success", {});
    })();
    return { created: true, legacyTokenMigrated: Boolean(legacyToken) };
  }

  public authenticateAdmin(adminId: string, password: string): boolean {
    const row = this.db.prepare("SELECT password_hash FROM admin_account WHERE admin_id=?").get(adminId) as { password_hash: string } | undefined;
    const placeholder = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    return verifyPassword(password, row?.password_hash ?? placeholder) && Boolean(row);
  }
  public changeAdminPassword(adminId:string,current:string,next:string):void{
    if(!this.authenticateAdmin(adminId,current))throw new Error("Current password is invalid.");
    if(next.length<12)throw new Error("New password must contain at least 12 characters.");
    this.db.prepare("UPDATE admin_account SET password_hash=?,updated_at=? WHERE admin_id=?").run(hashPassword(next),new Date().toISOString(),adminId);
    this.db.prepare("DELETE FROM admin_sessions WHERE admin_id=?").run(adminId);
  }

  public createSession(adminId: string): { token: string; csrf: string } {
    const token = createToken("mas"); const csrf = createToken("csrf");
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.db.prepare("INSERT INTO admin_sessions (session_hash,admin_id,csrf_hash,expires_at,created_at) VALUES (?,?,?,?,?)").run(hashToken(token), adminId, hashToken(csrf), expires, new Date().toISOString());
    return { token, csrf };
  }

  public session(token: string): AdminSession | undefined {
    return this.db.prepare("SELECT admin_id adminId, csrf_hash csrfHash FROM admin_sessions WHERE session_hash=? AND expires_at>?").get(hashToken(token), new Date().toISOString()) as AdminSession | undefined;
  }

  public revokeSession(token: string): void { this.db.prepare("DELETE FROM admin_sessions WHERE session_hash=?").run(hashToken(token)); }
  public verifyUserToken(token: string): boolean {
    const row = this.db.prepare("SELECT t.id FROM auth_tokens t JOIN app_users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND u.disabled_at IS NULL").get(hashToken(token)) as { id: number } | undefined;
    if (row) this.db.prepare("UPDATE auth_tokens SET last_used_at=? WHERE id=?").run(new Date().toISOString(), row.id);
    return Boolean(row);
  }

  public listUsers(): unknown[] { return this.db.prepare("SELECT id,slug,display_name displayName,created_at createdAt,disabled_at disabledAt FROM app_users ORDER BY id").all(); }
  public createUser(slug: string, displayName: string): { id: number; token: string } {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error("User slug is invalid.");
    const token = createToken(); const now = new Date().toISOString();
    const id = this.db.transaction(() => {
      const result = this.db.prepare("INSERT INTO app_users (slug,display_name,created_at) VALUES (?,?,?)").run(slug, displayName.trim().slice(0, 100), now);
      this.db.prepare("INSERT INTO auth_tokens (user_id,token_hash,label,created_at) VALUES (?,?,?,?)").run(result.lastInsertRowid, hashToken(token), "primary", now);
      return Number(result.lastInsertRowid);
    })();
    return { id, token };
  }

  public setUserEnabled(id: number, enabled: boolean): void {
    const result=this.db.prepare("UPDATE app_users SET disabled_at=? WHERE id=?").run(enabled ? null : new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error("User was not found.");
  }

  public listTokens(): unknown[] {
    return this.db.prepare(`SELECT t.id,t.user_id userId,u.slug userSlug,t.label,t.created_at createdAt,
      t.last_used_at lastUsedAt,t.revoked_at revokedAt FROM auth_tokens t JOIN app_users u ON u.id=t.user_id ORDER BY t.id DESC`).all();
  }

  public issueToken(userId: number, label: string): { id: number; token: string } {
    const token=createToken(); const result=this.db.prepare("INSERT INTO auth_tokens (user_id,token_hash,label,created_at) VALUES (?,?,?,?)")
      .run(userId,hashToken(token),label.trim().slice(0,100)||"token",new Date().toISOString());
    return { id:Number(result.lastInsertRowid),token };
  }

  public revokeToken(id: number): void {
    const result=this.db.prepare("UPDATE auth_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(new Date().toISOString(),id);
    if (result.changes !== 1) throw new Error("Token was not found.");
  }

  public listConnections(): unknown[] {
    return this.db.prepare("SELECT id,type,name,created_at createdAt,updated_at updatedAt FROM provider_connections ORDER BY id").all();
  }

  public addConnection(type: string, name: string, encryptedConfig: string): number {
    if (!["codex","openai","gemini"].includes(type)) throw new Error("Provider type is invalid.");
    const now=new Date().toISOString();
    return Number(this.db.prepare("INSERT INTO provider_connections (type,name,encrypted_config,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(type,name.trim().slice(0,100)||type,encryptedConfig,now,now).lastInsertRowid);
  }

  public removeConnection(id: number): void {
    const result=this.db.prepare("DELETE FROM provider_connections WHERE id=?").run(id);
    if (result.changes !== 1) throw new Error("Connection was not found.");
  }

  public latestConnection(type: string): { encryptedConfig: string } | undefined {
    return this.db.prepare("SELECT encrypted_config encryptedConfig FROM provider_connections WHERE type=? ORDER BY id DESC LIMIT 1").get(type) as {encryptedConfig:string}|undefined;
  }

  public tableView(name: string, page: number, pageSize: number): { columns: string[]; rows: unknown[]; total: number } {
    const views: Record<string,string>={
      app_users:"SELECT id,slug,display_name,created_at,disabled_at FROM app_users",
      auth_tokens:"SELECT id,user_id,label,created_at,last_used_at,revoked_at FROM auth_tokens",
      runtime_settings:"SELECT key,is_secret,updated_at FROM runtime_settings",
      audit_logs:"SELECT id,occurred_at,actor,action,target,outcome FROM audit_logs"
    };
    const query=views[name]; if(!query) throw new Error("Table is not available in the administration view.");
    const safeSize=Math.min(Math.max(pageSize,10),100); const safePage=Math.max(page,1);
    const rows=this.db.prepare(`${query} ORDER BY 1 DESC LIMIT ? OFFSET ?`).all(safeSize,(safePage-1)*safeSize);
    const total=(this.db.prepare(`SELECT COUNT(*) count FROM ${name}`).get() as {count:number}).count;
    return { columns:rows.length?Object.keys(rows[0] as object):[],rows,total };
  }

  public audit(actor: string, action: string, target: string, outcome: string, details: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO audit_logs (occurred_at,actor,action,target,outcome,details_json) VALUES (?,?,?,?,?,?)").run(new Date().toISOString(), actor, action, target, outcome, JSON.stringify(details));
  }
  public logs(limit = 100): unknown[] { return this.db.prepare("SELECT occurred_at occurredAt,actor,action,target,outcome,details_json details FROM audit_logs ORDER BY id DESC LIMIT ?").all(Math.min(limit, 500)); }
  public purgeAudit(retentionDays: number): void { this.db.prepare("DELETE FROM audit_logs WHERE occurred_at < ?").run(new Date(Date.now() - retentionDays * 86400000).toISOString()); }
  public overview(): unknown {
    const users = (this.db.prepare("SELECT COUNT(*) count FROM app_users WHERE disabled_at IS NULL").get() as { count:number }).count;
    const tokens = (this.db.prepare("SELECT COUNT(*) count FROM auth_tokens WHERE revoked_at IS NULL").get() as { count:number }).count;
    const connections=(this.db.prepare("SELECT COUNT(*) count FROM provider_connections").get() as {count:number}).count;
    return { users, tokens, connections };
  }

  private insertUserWithToken(slug: string, name: string, token: string, now: string): void {
    const result = this.db.prepare("INSERT INTO app_users (slug,display_name,created_at) VALUES (?,?,?)").run(slug, name, now);
    this.db.prepare("INSERT INTO auth_tokens (user_id,token_hash,label,created_at) VALUES (?,?,?,?)").run(result.lastInsertRowid, hashToken(token), "legacy", now);
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`);
    if (version === 0) this.db.exec(`
      CREATE TABLE admin_account (admin_id TEXT PRIMARY KEY,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE app_users (id INTEGER PRIMARY KEY,slug TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,created_at TEXT NOT NULL,disabled_at TEXT);
      CREATE TABLE auth_tokens (id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES app_users(id),token_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,revoked_at TEXT);
      CREATE TABLE admin_sessions (session_hash TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES admin_account(admin_id),csrf_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE runtime_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,is_secret INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
      CREATE TABLE audit_logs (id INTEGER PRIMARY KEY,occurred_at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,outcome TEXT NOT NULL,details_json TEXT NOT NULL);
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1, datetime('now'));
      PRAGMA user_version = 1;
    `);
    const current=this.db.pragma("user_version",{simple:true}) as number;
    if(current===1) this.db.exec(`
      CREATE TABLE provider_connections (id INTEGER PRIMARY KEY,type TEXT NOT NULL CHECK(type IN ('codex','openai','gemini')),name TEXT NOT NULL,encrypted_config TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (2, datetime('now'));
      PRAGMA user_version = 2;
    `);
  }
}
