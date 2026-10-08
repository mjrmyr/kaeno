import { lstat, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const pathFor = (dir: string) => join(dir, "credentials.json");
export async function loadKey(dir: string): Promise<string | undefined> {
  const file = pathFor(dir);
  let info;
  try { info = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isFile() || (info.mode & 0o077)) throw new Error(`Credentials at ${file} must be a regular file readable only by you (chmod 600).`);
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || typeof (value as { openai?: unknown }).openai !== "string")
    throw new Error(`Invalid credentials at ${file}`);
  return (value as { openai: string }).openai;
}
export async function saveKey(dir: string, key: string) {
  if (!/^sk-[\x21-\x7e]{12,}$/.test(key)) throw new Error("Enter a valid OpenAI API key (starting with sk-). It is never shown in the transcript.");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.credentials-${randomUUID()}`);
  try {
    await writeFile(temp, JSON.stringify({ openai: key }) + "\n", { flag: "wx", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, pathFor(dir));
  } finally { await rm(temp, { force: true }); }
}
