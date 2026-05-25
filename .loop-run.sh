#!/usr/bin/env bash
# Loop task runner for pi-remote-control
# Reads .loop-tasks.json, finds the first pending task, and outputs instructions
set -euo pipefail

TASK_FILE="/home/grunt/pi-remote-control/.loop-tasks.json"
REPO="/home/grunt/pi-remote-control"

# Find next pending task using python
python3 - "$TASK_FILE" << 'PYEOF'
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

for t in data["tasks"]:
    if t["status"] == "pending":
        print("=== Next task (#{}: {}) ===".format(t["id"], t["title"]))
        print()
        print("Description: {}".format(t["description"]))
        print("Files: {}".format(", ".join(t.get("files", []))))
        print()
        print("Action required:")
        print("  1. Read the task files listed above")
        print("  2. Implement the feature/fix described in the task")
        print("  3. Build to verify: cd {}/android/pi-remote-control-app && ./gradlew :app:assembleDebug".format(
            "/home/grunt/pi-remote-control"))
        print("  4. Commit the change")
        print("  5. Update .loop-tasks.json: mark task #{} as 'done'".format(t["id"]))
        sys.exit(0)

print("=== All tasks completed! No more pending work. ===")
print("Consider adding new tasks to .loop-tasks.json or stopping the loop.")
PYEOF

echo ""
echo "Current git log (last 3 commits):"
git -C "$REPO" log --oneline -3 2>/dev/null || true
