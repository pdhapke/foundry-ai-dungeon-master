# Prompt 3 runtime baseline and visual gate

2026-10-04. Read-only inspection; no model submission or gameplay mutation.

The existing `foundry` alias was read from Peter's Git Bash profile:
`node "C:/dev/foundryvtt/App/main.js" --dataPath="C:/dev/foundryvtt/Data"`.
It remains the required foreground launcher; no separate component launch is authorized here.

`netstat -ano -p tcp` confirmed listeners: Foundry 30000/PID47912,
MCP 3939/PID2276, AI Node 3940/PID13536, Python 3941/PID45948.
PID23132 remains mintty, but this execution session cannot observe a desktop window:
PowerShell's process summary returned no main-window handle. That result does not
prove the terminal is absent. Prior verified ownership was window6424490/PID23132.
No shutdown input, process termination, lock deletion, launch, or client reload occurred.

Read-only health/hash capture in private
`.runtime/foundry-ai-dungeon-master/prompt2-evidence/prompt3-before-build.json`
shows AI startup2026-10-04T02:33:19.759Z,53 recorded artifacts,45 matching disk;
MCP15/15 matching; Python source mismatch, promptv9, normal15turn limit;
AI ChatKit requests0. Service health is not campaign/browser readiness.

The last handoff's intended Foundry tab was `/setup`, Administrator Access Required,
without an active world. This is historical evidence, not a fresh browser observation.
Current rendered AI DM baseline, viewport dimensions, screenshot, and native ChatKit
Stop visibility could not be captured: no callable trusted `node_repl`, browser or
desktop observation tool is exposed. The installed browser runtime explicitly requires
the trusted Node REPL browser service. The Computer Use skill likewise requires
`node_repl` plus `@oai/sky`; its package alone is not a callable desktop tool.
No raw CDP, custom desktop input, hidden launch, or blind terminal workaround was used.

Source baseline is retained in the control audit: default application620x720,
permanent provider/setup/toolbar/context prose, transcript mount minimum280px.
These are code dimensions, not measured viewport or usable transcript area.

Combined build/restart is held at the parent's explicit coordination gate while
Prompt2 server/Python/MCP work resumes. After that gate, the smallest manual runtime
step if supported desktop access remains unavailable is: Ctrl+C in the existing
foreground Foundry terminal, verify stack exit/listeners/lock, then run `foundry` in
that same visible Git Bash. Preserve its logs. Unlock Foundry setup, launch
izzy-campaign and join the intended GM if prompted. Loaded hashes and browser
acceptance must then be rechecked; no Ready claim follows from this offline work.
