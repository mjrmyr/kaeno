import { readFileSync } from "node:fs";

// Playwright's documented namespace exception, applied to a pinned Docker
// allowlist rather than disabling seccomp. CI only; not a worker policy change.
export function browserSeccompProfile() {
  const profile = JSON.parse(
    readFileSync(
      new URL(
        "../.github/seccomp/docker-default-v28.0.0.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  profile.syscalls.push({
    names: ["clone", "setns", "unshare"],
    action: "SCMP_ACT_ALLOW",
    comment:
      "Allow Chromium to establish its unprivileged user namespace sandbox",
  });
  // Chromium chroots inside its new user namespace. Docker's baseline gates
  // this syscall on the *outer* CAP_SYS_CHROOT, which we deliberately drop.
  // Allow the syscall, not the capability: the kernel still checks namespace ownership.
  profile.syscalls.push({
    names: ["chroot"],
    action: "SCMP_ACT_ALLOW",
    comment: "Allow Chromium filesystem isolation inside its user namespace",
  });
  return profile;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(browserSeccompProfile()));
}
