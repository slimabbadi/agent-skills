# agent-skills

Skills for coding agents (Claude Code, Codex, OpenCode, Gemini CLI, and any tool that reads
`SKILL.md` folders). Each skill lives in `skills/<name>/`: a `SKILL.md` the agent reads, plus
any scripts it runs.

| Skill | What it does |
|---|---|
| [`ui-diff`](skills/ui-diff/SKILL.md) | Before/after check of a web UI change at minimal image-token cost: a text report of what changed (styles, text, layout, unexplained pixels) and at most one small cropped image. |

## Install a skill

Copy or symlink the skill folder into your agent's skills directory:

```sh
git clone https://github.com/slimabbadi/agent-skills.git
# Claude Code, for every project:
cp -r agent-skills/skills/ui-diff ~/.claude/skills/
# or for one project:
cp -r agent-skills/skills/ui-diff <project>/.claude/skills/
```

Other agents read the same folder from their own skills directory (for example
`~/.agents/skills/` or `~/.codex/skills/`). Then follow the skill's **Setup** section once;
`ui-diff` needs `agent-browser` and a one-time `npm install` run inside its `scripts/` folder.

## Adding a skill

- One folder per skill under `skills/`, named like the `name:` in its frontmatter.
- `SKILL.md` starts with `name` and a `description` that says what the skill does and when an
  agent should use it.
- Scripts ship with a self-test that CI runs on Linux and Windows
  ([workflow](.github/workflows/ci.yml)); add your skill to the matrix there.

## License

[MIT](LICENSE)
