from pathlib import Path
import re

p = Path('c:/Users/delar/Desktop/calculadora TD v1.0/calculadora TD/web/src/main.js')
text = p.read_text(encoding='utf-8')

pattern = re.compile(r'  const normalized = text[\s\S]*?return VOTE_NAME_TO_NUMBER\[cleaned\] \?\? 0;', re.S)
new = '''  const cleaned = text
    .normalize("NFD")
    .replace(/\\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  return VOTE_NAME_TO_NUMBER[cleaned] ?? 0;'''

text2, n = pattern.subn(lambda m: new, text, count=1)
if n:
    p.write_text(text2, encoding='utf-8')
print('replaced', n)
