from pathlib import Path

p = Path('c:/Users/delar/Desktop/calculadora TD v1.0/calculadora TD/web/src/main.js')
text = p.read_text(encoding='utf-8')

old_helper = '''  const normalized = text
    .normalize("NFD")
    .replace(/[-]/g, (ch) => ch)
    .replace(/[-]/g, "")
    .replace(/[-]/g, "");
  const cleaned = normalized
    .replace(/[^-]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
'''
new_helper = '''  const cleaned = text
    .normalize("NFD")
    .replace(/\\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
'''
old_helper = old_helper.replace('\n', '\r\n')
text = text.replace(old_helper, new_helper, 1)

old_duplicate = '''========== RESPUESTA (SOLO JSON, NADA MÁS) ==========
{"found": [{"name": "Nombre exacto de lista", "qty": 1, "vote": 0}]}

RESPUESTA:`;
'''
old_duplicate = old_duplicate.replace('\n', '\r\n')
text = text.replace(old_duplicate, '', 1)

p.write_text(text, encoding='utf-8')
print('patched')
