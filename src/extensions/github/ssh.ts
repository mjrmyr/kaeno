export async function setupSsh(source = "/etc/kaeno/ssh"): Promise<boolean> {
  const { copyFile, chmod, mkdir, writeFile, access } =
    await import("node:fs/promises");
  try {
    await access(`${source}/id_ed25519`);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
    return false;
  }
  const directory = `${process.env.HOME ?? "/home/agent"}/.ssh`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(`${source}/id_ed25519`, `${directory}/id_ed25519`);
  await chmod(`${directory}/id_ed25519`, 0o600);
  await copyFile(`${source}/known_hosts`, `${directory}/known_hosts`);
  await writeFile(
    `${directory}/config`,
    `Host github.com\n  IdentityFile ${directory}/id_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${directory}/known_hosts\n`,
    { mode: 0o600 },
  );
  return true;
}
