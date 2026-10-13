#!/bin/sh
# Opt-in network spike for the architecture, not part of npm test.
# Only downloads the pinned installer; all skill sources are harmless local fixtures.
set -eu
work=$(mktemp -d "${TMPDIR:-/tmp}/kaeno-skills-probe.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/source/skills/probe/scripts" "$work/source/skills/probe/references" "$work/installed" "$work/home"
printf '%s\n' '---' 'name: probe' 'description: Local architecture fixture.' '---' \
  'Read references/guide.md, then run scripts/probe.sh relative to this skill directory.' \
  > "$work/source/skills/probe/SKILL.md"
printf '%s\n' '#!/bin/sh' "printf 'skill-probe-ok\\n'" > "$work/source/skills/probe/scripts/probe.sh"
chmod 755 "$work/source/skills/probe/scripts/probe.sh"
printf '%s\n' 'Local reference fixture.' > "$work/source/skills/probe/references/guide.md"
printf '%s\n' 'harmless-outside-fixture-marker' > "$work/outside.txt"
cd "$work/installed"
install_fixture() {
  env -i PATH="$PATH" HOME="$work/home" DISABLE_TELEMETRY=1 \
    npm_config_cache="$work/npm-cache" npm_config_userconfig=/dev/null \
    npx --yes skills@1.7.2 add "$work/source" --skill probe --agent pi --copy --yes \
    > "$work/installer.log" 2>&1 || { printf 'Installer failed; output follows:\n'; tail -30 "$work/installer.log"; return 1; }
}
install_fixture
cmp "$work/source/skills/probe/SKILL.md" .agents/skills/probe/SKILL.md
cmp "$work/source/skills/probe/references/guide.md" .agents/skills/probe/references/guide.md
test -x .agents/skills/probe/scripts/probe.sh
test "$(.agents/skills/probe/scripts/probe.sh)" = skill-probe-ok
test -f skills-lock.json
printf 'PASS: entrypoint, reference, executable script, and staging lockfile preserved.\n'
# Demonstrate why validation must precede npx: --copy dereferences this outside link.
ln -s "$work/outside.txt" "$work/source/skills/probe/references/outside.txt"
install_fixture
cmp "$work/outside.txt" .agents/skills/probe/references/outside.txt
test ! -L .agents/skills/probe/references/outside.txt
printf 'CONFIRMED: source symlink dereferenced into ordinary output; source preflight required.\n'
