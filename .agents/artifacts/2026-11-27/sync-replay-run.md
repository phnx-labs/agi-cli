# agents sync: container replay, 1.23.58 vs fix/sync-remaining-defects

Fresh node:24-bookworm containers, real phnx-labs/.agents clone, real Codex from npm.

## Published 1.23.58
```
agents 1.23.58
1) agents add --yes wrote a sync manifest: NO
2) folder docs installed as skills: [AGENTS README ]
3) source repo after agents sync codex --yes: [ M plugins/code/.claude-plugin/plugin.json ]
   hand-made skill kept: yes
   Skipped resource selection for Codex@main (no terminal; rerun with --yes to sync new resources)
4) plain agents sync (no --yes) updated main: yes
4) plain agents sync (no --yes) updated 0.129.0: NO
   source repo after plain sync: []
```

## This branch (npm pack, installed only in the container)
```
agents 1.23.58
1) agents add --yes wrote a sync manifest: yes
2) folder docs installed as skills: []
3) source repo after agents sync codex --yes: []
   hand-made skill kept: yes
4) plain agents sync (no --yes) updated main: yes
4) plain agents sync (no --yes) updated 0.129.0: yes
   source repo after plain sync: []
```

## Script
```bash
set -u
# $1 = "npm" (published 1.23.58) or "dev" (/agents.tgz built from the branch)
if [ "$1" = npm ]; then npm i -g @phnx-labs/agents-cli@1.23.58 >/tmp/npm.log 2>&1; else npm i -g /agents.tgz >/tmp/npm.log 2>&1; fi
export AGENTS_CLI_DISABLE_AUTO_UPDATE=1
git config --global user.email lab@example.com; git config --global user.name lab
echo "agents $(agents --version)"
rm -rf ~/.agents ~/.codex
mkdir -p ~/.agents && git clone -q https://github.com/phnx-labs/.agents.git ~/.agents/.system

agents add codex --yes >/tmp/add.log 2>&1 || { echo "add failed"; tail -5 /tmp/add.log; }
V=~/.agents/.history/versions/codex/main/home
echo "1) agents add --yes wrote a sync manifest: $([ -f $V/.sync-manifest.json ] && echo yes || echo NO)"
echo "2) folder docs installed as skills: [$(ls $V/.codex/skills | grep -xE 'AGENTS|README|CLAUDE' | tr '\n' ' ')]"

cd ~/.agents/.system
P=$(ls -d plugins/*/.claude-plugin/plugin.json | head -1)
node -e "const f=process.argv[1];const m=JSON.parse(require('fs').readFileSync(f));m.commands=['x'];require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')" $P
git commit -qam "lab: bare commands field"
mkdir -p $V/.codex/skills/my-own-skill && printf -- "---\nname: my-own-skill\ndescription: hand made\n---\nhi\n" > $V/.codex/skills/my-own-skill/SKILL.md
agents sync codex --yes --force >/tmp/s3.log 2>&1
echo "3) source repo after agents sync codex --yes: [$(git status --porcelain | tr '\n' ' ')]"
echo "   hand-made skill kept: $([ -f $V/.codex/skills/my-own-skill/SKILL.md ] && echo yes || echo NO)"

agents add codex@0.129.0 --isolated --yes >/tmp/add2.log 2>&1 || { echo "add 0.129.0 failed"; tail -5 /tmp/add2.log; }
O=$(ls -d ~/.agents/.history/versions/codex/*/home | grep -v /main/ | head -1)
agents sync codex@$(basename $(dirname $O)) --yes >/dev/null 2>&1
echo "<!-- upstream edit -->" >> skills/teams/SKILL.md && git commit -qam "lab: edit teams"
agents sync --local </dev/null >/tmp/s4.log 2>&1
grep -E "Skipped resource selection" /tmp/s4.log | sed 's/^/   /'
for h in $V $O; do echo "4) plain agents sync (no --yes) updated $(basename $(dirname $h)): $(grep -q 'upstream edit' $h/.codex/skills/teams/SKILL.md && echo yes || echo NO)"; done
echo "   source repo after plain sync: [$(git status --porcelain | tr '\n' ' ')]"
```
