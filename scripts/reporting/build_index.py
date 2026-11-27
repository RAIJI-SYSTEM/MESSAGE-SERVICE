#!/usr/bin/env python3
"""Monta o índice HTML de todos os relatórios gerados."""
import html
import json
import sys
from pathlib import Path


def count(out):
    file = out / "summary.json"
    if not file.exists():
        return ""
    data = json.loads(file.read_text(encoding="utf-8"))
    if "tests" in data:
        return f"{data.get('passed', 0)}/{data['tests']} testes passaram"
    return ""


def card(title, description, href, available):
    state = "Disponível" if available else "Não gerado nesta execução"
    link = f"<a href='{href}'>Abrir relatório HTML</a>" if available else ""
    return f"""
    <article class="card">
      <h2>{title}</h2>
      <p>{description}</p>
      <p class="state">{state}</p>
      {link}
    </article>"""



def video_block(out: Path) -> str:
    """Bloco de destaque com o vídeo principal e link para a galeria E2E."""
    page = out / "e2e" / "videos.html"
    videos = sorted((out / "e2e" / "videos").glob("*.webm"))
    if not page.exists() or not videos:
        return ""
    featured = (
        next((v for v in videos if "navegacao" in v.name.lower()), None)
        or next((v for v in videos if "login" in v.name.lower()), videos[0])
    )
    label = f"Assistir aos {len(videos)} vídeos" if len(videos) > 1 else "Assistir ao vídeo"
    return f"""<section class="videos">
  <div>
    <h2>Vídeos dos testes E2E</h2>
    <p>Gravações das jornadas reais executadas no navegador e na API.
    {len(videos)} vídeo(s) desta execução.</p>
    <a class="btn" href="e2e/videos.html">{label}</a>
  </div>
  <video controls preload="metadata" src="e2e/videos/{html.escape(featured.name)}"></video>
</section>"""


def main(out: Path, kind: str):
    summary = count(out)
    items = [
        ("Resultados dos testes", "Lista e contagem dos testes Vitest executados.", "testes.html", (out / "testes.html").exists()),
        ("Cobertura de código", "Linhas, funções, branches e statements cobertos.", "cobertura/index.html", (out / "cobertura/index.html").exists()),
        ("Teste de mutação (StrykerJS)", "Mutantes gerados, mortos e sobreviventes por arquivo.", "mutacao/mutation.html", (out / "mutacao/mutation.html").exists()),
        ("Testes E2E (Playwright)", "Jornadas de navegador e API, com trace em caso de falha.", "e2e/index.html", (out / "e2e/index.html").exists()),
    ]
    cards = "".join(card(*item) for item in items)
    html = f"""<!doctype html>
<html lang="pt-BR"><meta charset="utf-8">
<title>Relatórios de testes</title>
<style>
body{{font-family:system-ui,Arial,sans-serif;margin:2rem;color:#111827;background:#f9fafb}}
h1{{margin-bottom:.25rem}} .sub{{color:#4b5563;margin-top:0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-top:1.5rem}}
.card{{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1rem;box-shadow:0 1px 2px #0001}}
.card h2{{font-size:1.05rem;margin:.1rem 0 .4rem}} .card p{{color:#4b5563;line-height:1.4}}
.state{{font-size:.85rem;color:#6b7280}} a{{color:#1d4ed8;font-weight:600}}
.videos{{display:grid;grid-template-columns:1.2fr 1fr;gap:1.25rem;align-items:center;background:#111827;color:#e5e7eb;border-radius:14px;padding:1.25rem;margin-top:1.25rem}}
.videos h2{{margin:.1rem 0 .4rem;color:#fff}} .videos p{{color:#cbd5e1;line-height:1.45;margin:.25rem 0 1rem}}
.videos video{{width:100%;border-radius:10px;background:#000;max-height:260px}}
.btn{{display:inline-block;background:#2563eb;color:#fff!important;text-decoration:none;padding:.65rem 1rem;border-radius:9px}}
@media(max-width:760px){{.videos{{grid-template-columns:1fr}}}}
</style>
<h1>Relatórios de testes</h1>
<p class="sub">{summary}</p>
{video_block(out)}
<div class="grid">{cards}</div>
</html>"""
    (out / "index.html").write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), "vitest")
