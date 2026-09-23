#!/bin/bash
# Reports remote git divergence into the session context.
# Deliberately does NOT pull: incoming commits may collide with untracked work,
# so the decision to merge stays with the model after inspecting the diff.
set -uo pipefail

payload=$(cat 2>/dev/null || echo '{}')
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // "UserPromptSubmit"' 2>/dev/null)
[ -z "$event" ] || [ "$event" = "null" ] && event="UserPromptSubmit"

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

git fetch --quiet --prune origin >/dev/null 2>&1

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  upstream=$(git rev-parse --abbrev-ref '@{u}')
  counts=$(git rev-list --left-right --count "@{u}...HEAD" 2>/dev/null || printf '0\t0')
  behind=$(printf '%s' "$counts" | cut -f1)
  ahead=$(printf '%s' "$counts" | cut -f2)
else
  upstream="(none)"
  behind=0
  ahead=0
fi

dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

if [ "$behind" -gt 0 ]; then
  incoming=$(git diff --name-only HEAD "@{u}" 2>/dev/null | head -25 | tr '\n' ' ')
  subjects=$(git log --oneline HEAD.."@{u}" 2>/dev/null | head -10 | tr '\n' '; ')
else
  incoming=""
  subjects=""
fi

jq -n \
  --arg event "$event" \
  --arg branch "$branch" \
  --arg upstream "$upstream" \
  --arg behind "$behind" \
  --arg ahead "$ahead" \
  --arg dirty "$dirty" \
  --arg incoming "$incoming" \
  --arg subjects "$subjects" \
  '
  ($behind | tonumber) as $b |
  ($dirty  | tonumber) as $d |
  {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: $event,
      additionalContext: (
        "[git] branch \($branch) vs \($upstream): behind \($behind), ahead \($ahead); \($dirty) uncommitted/untracked path(s)."
        + (if $b > 0 then
             " INCOMING COMMITS: \($subjects) FILES: \($incoming)"
             + (if $d > 0
                then " Working tree is NOT clean - inspect incoming paths for collisions before pulling; never pull blind."
                else " Tree is clean - a --ff-only pull is safe." end)
           else "" end)
      )
    }
  }'
