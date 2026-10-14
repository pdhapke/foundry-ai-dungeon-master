# Independent partial latency benchmark gate

PARTIAL/BLOCKED benchmark:2 directdoor trials confirmed,2 embeddeddoor trials confirmed, third direct submission rejected by browser client authentication. Stop honored; no remaining4 embedded or HP trials, no retries/resubmissions. Raw traces prove exactly2 model-request and2 model-stream-invocation records. Providerretrylimit0, cap1, automaticfalse verified. No claim of completed6+6 benchmark, stable warm latency, percentile or speed acceptance.

|Door trial|Submit→native confirmed end|Browser receipt arrival|Queue|Python context|Model request→response|Native execution|
|---|---:|---:|---:|---:|---:|---:|
|Direct first|207.5ms|253.8ms|8.14ms|—|—|13.9ms|
|Embedded first|6180.6ms|6340.0ms|8.22ms|751.0ms|3848.6ms|11.6ms|
|Embedded repeat|7664.0ms|7754.4ms|11.72ms|922.4ms|5766.4ms|11.1ms|
|Direct repeat|117.1ms|137.1ms|5.32ms|—|—|5.3ms|

Native/browser clockId matches across four trials; subtraction uses same document monotonic clock only. Browser submit mark is fetch entry, excludes typing/earlier UI work. Native end is completed registered command/readback, not exact DB mutation timestamp. Receipt arrival is browser transport detection; rendering is qualitative root screenshot/AX (first directtoast missed), no numeric render timestamp. Response end has no separate narration requested. Evidence raw browser/traces pertrial latency-benchmark-independent-*.json.

Observed measured segments, not yet optimized: embedded Node queuedauthfinished→credentialsresolved sameNode-clock intervals1140.4/570.3ms; catalogrefresh355.3/678.1ms inside context751.0/922.4ms; model3848.6/5766.4ms largest measured segment. Tool158.7/149.6ms, SQLite factualreceipt commit14.49/9.45ms; native mechanics11.6/11.1ms; core receiptpersist3.03/2.36ms. Nested spans overlap and must not be added. Firstuse versus repeat identifies ordering only: repeat occurs~105s after prior prompt, outside60s credentialcachewindow; providerwarm/cold unknown. Two mixed conditions insufficient bottleneck optimization proof, but clearly separate longmodel/credential/context segments from short native mechanics.

Instrumentation limitation: Python trace elapsed origins reset across copied contexts; rows have no scopeId in this loadedbuild. Crossscope elapsed comparisons can be misleading. Explicit durationMs spans and matchedbrowser/native clocks above remain valid; no reconstruction by crossprocess walltimes. MissingHTTPproviderrequestID is explicitly unavailable, distinct responsehash exists. Finalcounters AI/MCPdropped0errors0, Pythondropped0/write56/cumulative150.11ms/max6.56ms, browserdropped0overbudget0 in retained exports. Sinkoverhead excludesstdout. Offline scopeId repair will require new prepared/loaded verification before any future run.

Mechanics PASS for three immediate independent readbacks: both embeddeddoors and directrepeatopen. Directfirst later freshreadbackclosed raced root model-free reset; raw confirmed trace/rootreset receipt explains state and independent freshresult is unavailable for thattrial. Root reports third direct rejection Connect as Foundry GM; MCPstillconnectedGM and healthready are separate current observations, not diagnosis of provider expiry. No inferred successful thirdmutation.

Restoration PASS: latency-benchmark-independent-restoration-check.json matches before originals exactly: activeIZZY03/pausedtrue/noactivecombat; inactivefixture token200/200 doorclosed HP20max20temp0 combatinactive1/0. Rootbrowser restored originalpausedscene. Automaticfalse. Disktemporarycap removed priornull; loadedcap1 remains until usermanualrestart. No process/service lifecycle actions byvalidator, no test-owned backgroundservice launched. No more inference underunusedallowance.

Required next gate: usermanualspeed feedback remains open; Phase3 paused, no optimization or extra inference. Clientauthreadiness needs zero-inference reconnection/manual steps before futureapprovedwork. Source instrumentation repair alone is not live acceptance.
