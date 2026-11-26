#!/usr/bin/env python3
"""Gera HTML de resultados a partir do JSON do Vitest."""
import html
import json
import sys
from pathlib import Path


def main(out: Path):
    data = json.loads((out / "vitest.json").read_text(encoding="utf-8"))
    rows = []
    for file in data.get("testResults", []):
        name = file.get("name", "arquivo")
        for test in file.get("assertionResults", []):
            status = test.get("status", "unknown")
            duration = test.get("duration") or 0
            rows.append((name, test.get("fullName") or test.get("title", ""), status, duration))
    total = data.get("numTotalTests", len(rows))
    passed = data.get("numPassedTests", sum(1 for r in rows if r[2] == "passed"))
    failed = data.get("numFailedTests", sum(1 for r in rows if r[2] == "failed"))
    skipped = data.get("numPendingTests", sum(1 for r in rows if r[2] in ("skipped", "pending")))
    body = []
    for file, name, status, duration in rows:
        cls = "ok" if status == "passed" else ("bad" if status == "failed" else "skip")
        body.append(
            f"<tr><td>{html.escape(file)}</td><td>{html.escape(name)}</td>"
            f"<td class='{cls}'>{html.escape(status)}</td><td>{duration:.0f} ms</td></tr>"
        )
    page = f"""<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<title>Testes Vitest</title>
<style>body{{font-family:system-ui,Arial,sans-serif;margin:2rem}}table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #d1d5db;padding:.45rem;text-align:left}}th{{background:#f3f4f6}}
.ok{{color:#047857}}.bad{{color:#b91c1c}}.skip{{color:#6b7280}}</style>
<h1>Testes — Vitest</h1>
<p><strong>Total:</strong> {total} · <strong>Passaram:</strong> {passed} · <strong>Falharam:</strong> {failed} · <strong>Ignorados:</strong> {skipped}</p>
<table><thead><tr><th>Arquivo</th><th>Teste</th><th>Status</th><th>Duração</th></tr></thead><tbody>
{''.join(body)}
</tbody></table></html>"""
    (out / "testes.html").write_text(page, encoding="utf-8")
    (out / "summary.json").write_text(
        json.dumps(
            {"tests": total, "passed": passed, "failed": failed, "skipped": skipped},
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main(Path(sys.argv[1]))
