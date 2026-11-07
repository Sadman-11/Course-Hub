#!/usr/bin/env bash
# Full-scale dry rehearsal of the reorganisation, entirely on this machine:
#   bootstrap sync -> apply plan -> sync (expects renames + deletion approval) -> approve -> verify
# using a local folder as "Drive" and a local bare repo as "GitHub", at the real paths.
#
#   bash tools/rehearse.sh <drive-manifest.json> [workdir]
#
# Get a fresh manifest with:  node sync/index.js --list-drive=data/drive-manifest.json
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
R="${2:-$(mktemp -d)}/rehearsal"
rm -rf "$R" && mkdir -p "$R/drive" "$R/seed"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.longpaths GIT_CONFIG_VALUE_0=true
G() { git -c user.name=t -c user.email=t@t -c core.autocrlf=false "$@"; }

# Same files on both sides. Contents derive from the tidied name + size, so files
# the plan calls duplicates are byte-identical and everything else differs.
node --input-type=module -e '
import fs from "fs"; import path from "path"; import { pathToFileURL } from "url";
const [proj, manifest, ...roots] = process.argv.slice(1);
const { cleanName } = await import(pathToFileURL(path.join(proj, "shared/taxonomy.js")).href);
for (const f of JSON.parse(fs.readFileSync(manifest, "utf8")).filter((f) => f.type === "file")) {
  // With a live listing the real md5 is the content, so duplicates match exactly as on Drive.
  const body = f.md5 || `${cleanName(path.basename(f.path)).toLowerCase().replace(/[\s_-]+/g, " ")}|${f.size}`;
  const big = f.size > 100 * 1024 * 1024;
  for (const [i, r] of roots.entries()) {
    if (big && i === 1) continue; // over GitHub limit: Drive only
    const p = path.join(r, f.path); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, big ? body.padEnd(2000, "x") : body);
  }
}' "$PROJ" "$MANIFEST" "$R/drive" "$R/seed"
G init -q --bare -b main "$R/remote.git"
G -C "$R/remote.git" config uploadpack.allowFilter true
G -C "$R/remote.git" config uploadpack.allowAnySHA1InWant true
G -C "$R/seed" init -q -b main && G -C "$R/seed" add -A && G -C "$R/seed" commit -qm seed && G -C "$R/seed" push -q "file:///$R/remote.git" main

export SYNC_FAKE_DRIVE="$R/drive" SYNC_REPO_URL="file:///$R/remote.git" SYNC_SIZES_GIT_DIR="$R/remote.git"
export DRIVE_ROOT_ID=root SYNC_MAX_GIT_BYTES=1000 SYNC_API= SYNC_TOKEN= GITHUB_REPOSITORY=
cd "$PROJ"
echo "== bootstrap sync";              node sync/index.js | grep -E "plan|done"
echo "== plan + apply";                node tools/reorg-plan.mjs "$MANIFEST" "$R/reorg" | head -1
node tools/reorg-apply.mjs "$R/reorg/plan.json" --apply --force | grep -E "moved|emptyFolders|kept" || true
echo "== sync after reorg";            set +e; node sync/index.js > "$R/sync2.log" 2>&1; code=$?; set -e; grep -E "plan|blocked" "$R/sync2.log"
HASH=$(grep -oE "hash=[0-9a-f]+" "$R/sync2.log" | head -1 | cut -d= -f2)
if [ "$code" = 3 ]; then echo "== approve $HASH"; node sync/index.js --approve="$HASH" | grep -E "plan|done"; fi
echo "== verify"
node -e '
const fs = require("fs"), { execSync } = require("child_process");
const [planFile, remote] = process.argv.slice(1);
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const want = new Set(plan.filter((p) => p.action !== "trash" && p.size <= 100 * 1024 * 1024).map((p) => p.to));
const have = new Set(execSync(`git -C "${remote}" ls-tree -r --name-only -z main`).toString().split("\0").filter((p) => p && !p.startsWith(".sync/")));
const missing = [...want].filter((p) => !have.has(p)), extra = [...have].filter((p) => !want.has(p));
const renames = execSync(`git -C "${remote}" diff --find-renames=100% --name-status main~1 main`).toString().split("\n").filter((l) => l.startsWith("R100")).length;
console.log({ expected: want.size, onGitHub: have.size, missing: missing.length, extra: extra.length, exactRenames: renames });
if (missing.length || extra.length) { console.log({ missing: missing.slice(0, 10), extra: extra.slice(0, 10) }); process.exit(1); }
' "$R/reorg/plan.json" "$R/remote.git"
before=$(G -C "$R/remote.git" rev-parse main); node sync/index.js > /dev/null
[ "$before" = "$(G -C "$R/remote.git" rev-parse main)" ] && echo "follow-up sync is a no-op ✓"
echo "rehearsal OK ($R)"
