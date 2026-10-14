from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'module/src/ai-dungeon-master/application.ts'
raw = p.read_bytes()
old = b"setupButton?.addEventListener('click'"
new = b"if (setupButton?.tagName === 'BUTTON') setupButton.addEventListener('click'"
assert raw.count(old) == 1
p.write_bytes(raw.replace(old, new))
