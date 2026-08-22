import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const sourceArgument = process.argv[2];
if (!sourceArgument) throw new Error("Usage: npm run restore:server -- <backup.db>");
const source = resolve(sourceArgument);
const destination = resolve(process.env.MENTOR_DATABASE_PATH || join(process.cwd(), ".mentor-code", "data", "app.db"));
if (source === destination) throw new Error("Backup and active database paths must differ.");
if (!existsSync(source)) throw new Error(`Backup does not exist: ${source}`);
if (existsSync(`${destination}-wal`) || existsSync(`${destination}-shm`)) throw new Error("Stop the App Server and remove no files; WAL state is still present.");

const candidate = new Database(source, { readonly: true, fileMustExist: true });
const integrity = candidate.pragma("integrity_check", { simple: true });
const version = candidate.pragma("user_version", { simple: true });
candidate.close();
if (integrity !== "ok") throw new Error("Backup failed SQLite integrity_check.");
if (typeof version !== "number" || version > 2) throw new Error(`Backup schema ${String(version)} is newer than supported schema 2.`);

const backupDirectory = resolve(process.env.MENTOR_BACKUP_DIR || join(process.cwd(), ".mentor-code", "backups"));
mkdirSync(backupDirectory, { recursive: true });
if (existsSync(destination)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(destination, join(backupDirectory, `before-restore-${stamp}-${basename(destination)}`));
}
copyFileSync(source, destination);
console.log(destination);
