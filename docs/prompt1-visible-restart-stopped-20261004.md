# Graceful visible-terminal shutdown; relaunch blocked

Peter explicitly authorized graceful stopping through the visible terminal for this bounded work today, superseding the earlier manual-stop rule. No inference or allowance was approved.

Current state was rechecked, not inferred from historical PID: Win32 enumeration found visible window2162952 owned by mintty PID13540 with the approved terminal title. Process inspection confirmed its shell/winpty ancestry led to Foundry App/main.js PID35996 and child MCP25340, AI17384 and Python38740/29288. Listener ownership matched 30000/3939/3940/3941. The defining existing alias in Peter's .bashrc was reread.

Windows denied a foreground-focus attempt, and no global key was sent. Directed terminal WM_CHAR input delivered Ctrl+C (character3) to the verified terminal only. Visual inspection of that window confirmed Foundry's `Shutting down Foundry Virtual Tabletop server` and `Shutdown success. Goodbye!` messages. Subsequent escalated checks found zero intended stack processes/listeners and no active options.json.lock. No process kill or lock deletion occurred. The terminal and its shutdown logs remain visible; screenshot retained privately at C:/dev/FoundryVtt/.runtime/foundry-ai-dungeon-master/terminal-after-interrupt.png.

The original launch invoked an interactive login shell with a one-shot `-c` command. After the alias exited, that shell also exited. Mintty `--hold always` retains the window and logs, but no shell remains to receive the alias. Installed help and the official mintty manual describe held exited sessions and cloning/new windows, with no supported same-window shell relaunch established. No undocumented restart action or process injection was used. The parent's explicit same-visible-terminal requirement therefore blocks relaunch until disposition.

Required parent action: authorize replacing the held terminal with a new verified visible Git Bash terminal using a persistent interactive shell, preserving the old shutdown-log window, then running the existing foundry alias in the foreground there. Do not launch hidden components. This is the only requested terminal-scope adjustment; no new access, storage change, inference or rollout follows.

Before shutdown, authenticated supported capability report showed zero connected browser clients. Read-only Windows UI Automation found no identifiable Foundry Chrome title/tab, but this is not proof that no stored authorized session exists. No browser navigation or session changes occurred. Once approved visible startup succeeds, inspect/use existing browser session via supported automation before requesting any manual GM action.

The repaired manifest remains disk-only until relaunch. Fresh health/privacy/data/authenticated GM/UI/isolation checks and StageA fixture binding were not run against a restarted service. No inference, usage allowance or Prompt2 work occurred. No public-source restoration or gameplay mutation occurred.

Official terminal behavior reference: https://mintty.github.io/mintty.1.html (hold setting and window commands).
