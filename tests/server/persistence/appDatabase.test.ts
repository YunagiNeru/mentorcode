import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AppDatabase } from "../../../src/server/persistence/appDatabase";
import { SecretBox, hashPassword, verifyPassword } from "../../../src/server/security/adminCredentials";

describe("AppDatabase", () => {
  it("bootstraps one administrator and migrates the legacy token as a hash", () => {
    const dir=mkdtempSync(join(tmpdir(),"mentor-db-")); const bootstrap=join(dir,"bootstrap.json");
    writeFileSync(bootstrap, JSON.stringify({ adminId:"operator", password:"correct-horse-battery" }));
    const db=new AppDatabase(join(dir,"app.db"));
    expect(db.bootstrap(bootstrap,"legacy-secret")).toEqual({created:true,legacyTokenMigrated:true});
    expect(db.authenticateAdmin("operator","correct-horse-battery")).toBe(true);
    expect(db.verifyUserToken("legacy-secret")).toBe(true);
    expect(db.verifyUserToken("wrong")).toBe(false); db.close();
    const reopened=new AppDatabase(join(dir,"app.db")); expect(()=>reopened.bootstrap(bootstrap,undefined)).toThrow(/Remove/); reopened.close();
  });
  it("refuses bootstrap without a bootstrap file", () => { const db=new AppDatabase(":memory:"); expect(()=>db.bootstrap(undefined,undefined)).toThrow(/BOOTSTRAP/); db.close(); });
  it("manages tokens, users, provider connections, and allowlisted table views", () => {
    const dir=mkdtempSync(join(tmpdir(),"mentor-ops-"));const bootstrap=join(dir,"bootstrap.json");writeFileSync(bootstrap,JSON.stringify({adminId:"operator",password:"correct-horse-battery"}));
    const db=new AppDatabase(join(dir,"app.db"));db.bootstrap(bootstrap,undefined);const user=db.createUser("team-a","Team A");
    expect(db.verifyUserToken(user.token)).toBe(true);const issued=db.issueToken(user.id,"automation");expect(db.verifyUserToken(issued.token)).toBe(true);db.revokeToken(issued.id);expect(db.verifyUserToken(issued.token)).toBe(false);
    db.setUserEnabled(user.id,false);expect(db.verifyUserToken(user.token)).toBe(false);db.setUserEnabled(user.id,true);expect(db.verifyUserToken(user.token)).toBe(true);
    const connection=db.addConnection("openai","Primary","encrypted");expect(db.listConnections()).toHaveLength(1);db.removeConnection(connection);expect(db.listConnections()).toHaveLength(0);
    expect(db.tableView("app_users",1,50).total).toBe(1);expect(()=>db.tableView("admin_account",1,50)).toThrow(/not available/);db.close();
  });
});

describe("credential primitives", () => {
  it("verifies scrypt passwords and AES-GCM secrets", () => {
    const password=hashPassword("strong-password"); expect(verifyPassword("strong-password",password)).toBe(true); expect(verifyPassword("wrong",password)).toBe(false);
    const box=new SecretBox(Buffer.alloc(32,7).toString("base64")); const encrypted=box.encrypt("provider-secret"); expect(encrypted).not.toContain("provider-secret"); expect(box.decrypt(encrypted)).toBe("provider-secret");
  });
});
