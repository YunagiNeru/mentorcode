import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const source = resolve(process.env.MENTOR_DATABASE_PATH || join(process.cwd(), ".mentor-code", "data", "app.db"));
const directory = resolve(process.env.MENTOR_BACKUP_DIR || join(process.cwd(), ".mentor-code", "backups"));
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = join(directory, `app-${stamp}.db`);
const database = new Database(source, { readonly: true, fileMustExist: true });
await database.backup(destination);
database.close();
console.log(destination);
