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
  return profile;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(JSON.stringify(browserSeccompProfile()));
}
