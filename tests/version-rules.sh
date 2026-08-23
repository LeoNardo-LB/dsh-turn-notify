set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # 先于 cd 解析（$0 是相对路径）
T=$(mktemp -d)
cd $T
git init -q -b main && git config user.email t@t && git config user.name t
mkdir -p scripts
cp "$REPO_ROOT/scripts/version.sh" scripts/
printf '{\n  "name": "t",\n  "version": "1.0.1"\n}\n' > package.json
git add -A && git commit -qm init && git tag v1.0.1
S=./scripts/version.sh
PASS=0; FAIL=0
expect() { if echo "$2" | grep -q "$1"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $3 | expect[$1] got[$2]"; fi }
expect_reject() { if OUT=$(bash $S $1 2>&1); then FAIL=$((FAIL+1)); echo "FAIL(should reject): $2 -> $OUT"; else PASS=$((PASS+1)); fi }
snap() { git add -A >/dev/null 2>&1 || true; git commit -qm x >/dev/null 2>&1 || true; }

expect "1.0.2-dev.1" "$(bash $S dev --no-git 2>&1)" "stable->dev"; snap; git tag v1.0.2-dev.1
expect "1.0.2-dev.2" "$(bash $S dev --no-git 2>&1)" "dev iterate"; snap; git tag v1.0.2-dev.2
expect "1.0.2-beta" "$(bash $S beta --no-git 2>&1)" "dev->beta"; snap; git tag v1.0.2-beta
expect "1.0.2-dev.3" "$(bash $S dev --no-git 2>&1)" "beta rework"; snap; git tag v1.0.2-dev.3
expect "1.0.2-beta" "$(bash $S beta --no-git 2>&1)" "rework->beta"; snap
expect "1.0.2" "$(bash $S stable --no-git 2>&1)" "beta->stable"; snap
expect "1.1.0-dev.1" "$(bash $S dev --minor --no-git 2>&1)" "minor cycle"; snap
expect "2.0.0-dev.1" "$(bash $S dev --major --no-git 2>&1)" "major cycle"; snap
expect_reject "stable" "dev->stable illegal"
bash $S beta --no-git >/dev/null 2>&1; snap
expect_reject "beta" "beta->beta illegal"
expect "dev.1" "$(bash $S dev --major --no-git 2>&1)" "beta+scope = re-scope cycle"; snap
bash $S beta --no-git >/dev/null 2>&1; snap
bash $S stable --no-git >/dev/null 2>&1; snap
expect_reject "beta" "stable->beta illegal"
printf '{\n  "name": "t",\n  "version": "1.0.2-rc.1"\n}\n' > package.json
expect_reject "check" "rc suffix rejected"
printf '{\n  "name": "t",\n  "version": "1.0.2-dev"\n}\n' > package.json
expect_reject "current" "dev without n rejected"
printf '{\n  "name": "t",\n  "version": "2.0.0"\n}\n' > package.json
expect "2.0.0" "$(bash $S current 2>&1)" "current ok"
echo '{"name":"t","version":"2.0.0"}' > package.json
expect "1.0.2-dev.4" "$(bash $S dev --no-git 2>&1)" "compact JSON bump + tag-based fallback"
rm -rf $T
echo "=== PASS=$PASS FAIL=$FAIL ==="
