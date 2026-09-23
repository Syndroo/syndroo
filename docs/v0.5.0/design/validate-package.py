#!/usr/bin/env python3
"""Validate this design package, not the Syndroo implementation.

Usage: python validate-package.py [--zip /path/to/package.zip]
Writes document-validation.json in this directory. No network or repository access.
The report itself and SHA256SUMS.txt are excluded from recursive payload hashing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
CHECKS: list[dict[str, object]] = []


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise ValueError(detail)


def check(name: str, fn) -> None:
    try:
        detail = fn()
        CHECKS.append({"name": name, "status": "PASS", "evidence": detail})
    except Exception as exc:
        CHECKS.append({"name": name, "status": "FAIL", "evidence": str(exc)})


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def original_acceptance() -> dict:
    with zipfile.ZipFile(ROOT / "sources/v1-original-design-package.zip") as zf:
        matches = [n for n in zf.namelist() if n.endswith("/acceptance-results.template.json") or n == "acceptance-results.template.json"]
        require(len(matches) == 1, f"Expected one original acceptance file: {matches}")
        return json.loads(zf.read(matches[0]))


def no_code(text: str) -> str:
    return re.sub(r"(?ms)^```[^\n]*\n.*?^```\s*$", "", text)


def heading_anchors(text: str) -> set[str]:
    anchors = set(re.findall(r'<a\s+id="([^"]+)"', text))
    counts: dict[str, int] = {}
    for h in re.findall(r"(?m)^#{1,6}\s+(.+)$", no_code(text)):
        slug = re.sub(r"[^\w\-\s]", "", re.sub(r"[`*_]", "", h).lower()).replace(" ", "-")
        n = counts.get(slug, 0)
        counts[slug] = n + 1
        anchors.add(slug if n == 0 else f"{slug}-{n}")
    return anchors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", dest="zip_path", type=Path)
    args = parser.parse_args()
    required = ["00-README.md", "01-DESIGN.md", "02-ARCHITECTURE-DECISIONS.md", "03-ACCEPTANCE.md", "04-HANDOFF.md", "05-SOURCES-AND-BASELINE.md", "06-INTEGRATION-REVIEW.md", "07-CONTRACTS-AND-FAILURE-MATRIX.md", "acceptance-results.template.json", "acceptance-change-log.json", "source-integration-map.json", "input-provenance.json", "SHA256SUMS.txt", "sources/portable-storage-queue.original.txt", "sources/v1-original-design-package.zip"]
    def files_present():
        missing = [n for n in required if not (ROOT/n).is_file() or (ROOT/n).stat().st_size == 0]
        require(not missing, f"Missing/empty files: {missing}")
        return {"required_files": len(required)}
    check("required_files_present", files_present)

    def json_syntax():
        names = [p.name for p in ROOT.glob("*.json") if p.name != "document-validation.json"]
        for n in names: load(n)
        return names
    check("json_payloads_parse", json_syntax)

    # Data loads deliberately fail with a clear error instead of fabricating a pass.
    try:
        acceptance, mapping, changes, provenance = [load(n) for n in ("acceptance-results.template.json", "source-integration-map.json", "acceptance-change-log.json", "input-provenance.json")]
        old = original_acceptance()
    except Exception as exc:
        print(f"Cannot validate data: {exc}", file=sys.stderr)
        return 2
    items = acceptance["checks"]
    ids = [c["id"] for c in items]
    old_ids = [c["id"] for c in old["checks"]]

    def unique_ids():
        require(len(ids) == len(set(ids)), "Duplicate acceptance IDs")
        require(all(re.fullmatch(r"[A-Z]+-\d{2}", i) for i in ids), "Malformed acceptance ID")
        return {"unique_ids": len(ids)}
    check("acceptance_ids_unique", unique_ids)

    def retained():
        require(len(old_ids) == 66, "Unexpected original count")
        require(set(old_ids).issubset(ids), "Original IDs were removed")
        require(acceptance["prior_acceptance_ids_preserved"] == old_ids, "Original ID order changed in preservation list")
        return {"original": len(old_ids), "retained": len(set(old_ids) & set(ids)), "new": len(ids)-len(old_ids)}
    check("all_original_acceptance_ids_retained", retained)

    def diff_accounted():
        now = {c["id"]: c for c in items}
        prior = {c["id"]: c for c in old["checks"]}
        changed = {i for i in old_ids if prior[i]["criterion"] != now[i]["criterion"]}
        logged = {c["id"] for c in changes["changes"]}
        require(changed == logged, f"Unrecorded differences: {changed ^ logged}")
        for c in changes["changes"]:
            require(c["previous_criterion"] == prior[c["id"]]["criterion"], f"Incorrect old text: {c['id']}")
            require(c["revised_criterion"] == now[c["id"]]["criterion"], f"Incorrect new text: {c['id']}")
            require(c["safety_goal_preserved"] is True and bool(c["reason"]), "Missing disclosed rationale")
        return {"disclosed_existing_revisions": len(changed)}
    check("existing_criterion_changes_fully_disclosed", diff_accounted)

    def all_unrun():
        require(all(c["status"] == "NOT_RUN" for c in items), "Product result claims detected")
        require(all(c["actual_command"] is None and c["exit_code"] is None and not c["evidence"] for c in items), "Template contains fabricated execution evidence")
        require(acceptance["implementation_status"] == "not_started", "Unexpected implementation status")
        return {"product_checks_not_run": len(items)}
    check("product_tests_not_run_and_no_invented_evidence", all_unrun)

    def counts():
        s = acceptance["summary"]
        local = sum(c["required_for"] == "local" for c in items)
        live = sum(c["required_for"] == "live" for c in items)
        require((len(items), local, live) == (120, 118, 2), "Unexpected current counts")
        require((s["total"], s["local_required"], s["live_separate_authorization"], s["not_run"]) == (len(items), local, live, len(items)), "Incorrect summary")
        require(s["passed"] == s["failed"] == s["blocked"] == 0, "Incorrect unexecuted summary")
        return s
    check("acceptance_summary_consistent", counts)

    def authorization():
        require(not acceptance["live_actions_authorized"] and not acceptance["publish_or_deploy_authorized"], "Unexpected authorization")
        require(all(c["requires_separate_authorization"] for c in items if c["required_for"] == "live"), "Live authorization missing")
        for a in old["checks"]:
            b = next(c for c in items if c["id"] == a["id"])
            require(a["required_for"] == b["required_for"], "Original local gate downgraded")
        return "Original local/live requirements and action-time boundaries retained"
    check("authorization_and_required_gates_preserved", authorization)

    def markdown_matrix():
        text = (ROOT/"03-ACCEPTANCE.md").read_text()
        matrix_ids = re.findall(r"(?m)^\| ([A-Z]+-\d{2}) \|", text)
        require(matrix_ids == ids, "Markdown and JSON ID/order differ")
        by_line = {re.match(r"\| ([A-Z]+-\d{2}) \|", l).group(1): l for l in text.splitlines() if re.match(r"\| ([A-Z]+-\d{2}) \|", l)}
        for c in items:
            expected = c["criterion"].replace("|", "／").replace("\n", "；")
            require(expected in by_line[c["id"]] and by_line[c["id"]].endswith("| NOT_RUN |"), f"Criterion/state mismatch: {c['id']}")
        return {"matched_rows": len(matrix_ids)}
    check("markdown_and_json_acceptance_match", markdown_matrix)

    def inputs_identical():
        for entry in provenance["inputs"]:
            data = (ROOT / entry["package_path"]).read_bytes()
            require(len(data) == entry["bytes"] and sha(data) == entry["sha256"], f"Input changed: {entry['package_path']}")
        return [{"file": e["package_path"], "sha256": e["sha256"]} for e in provenance["inputs"]]
    check("original_inputs_byte_hashes_preserved", inputs_identical)

    def source_structure():
        src = (ROOT / mapping["source_file"]).read_text().splitlines()
        heads = [(i+1,l) for i,l in enumerate(src) if re.match(r"^# \d+\. ", l)]
        require(len(src) == 2323 and len(heads) == 53, "Source structure differs")
        require(len(mapping["source_sections"]) == 53, "Missing source section mappings")
        for i, (m, (line, title)) in enumerate(zip(mapping["source_sections"], heads), 1):
            end = heads[i][0]-1 if i < len(heads) else len(src)
            require((m["section"],m["title"],m["source_start_line"],m["source_end_line"]) == (i,title.split('. ',1)[1],line,end), f"Bad source mapping §{i}")
        return {"source_lines": len(src), "mapped_sections": len(heads)}
    check("all_source_sections_and_exact_ranges_mapped", source_structure)

    def rules_complete():
        expected = [f"RULE-{i:03d}" for i in range(1,16)]
        require([r["id"] for r in mapping["normative_rules"]] == expected, "Rules missing")
        src = (ROOT/mapping["source_file"]).read_text()
        require(all(r in src for r in expected), "Rule not present in original")
        return {"rules": len(expected)}
    check("all_15_source_rules_preserved", rules_complete)

    def mapping_ids_valid():
        entries = mapping["source_sections"] + mapping["normative_rules"]
        for e in entries:
            require(e["acceptance_ids"] and all(i in ids for i in e["acceptance_ids"]), f"Invalid mapped acceptance IDs: {e}")
        return {"mapping_entries": len(entries)}
    check("source_mapping_targets_existing_acceptance_ids", mapping_ids_valid)

    def mapping_markdown():
        md = (ROOT/"06-INTEGRATION-REVIEW.md").read_text()
        require(re.findall(r"(?m)^\| §(\d+) \|",md) == [str(i) for i in range(1,54)], "Markdown section mapping incomplete")
        require(re.findall(r"(?m)^\| (RULE-\d{3}) \|",md) == [r["id"] for r in mapping["normative_rules"]], "Markdown rule mapping incomplete")
        for s in mapping["source_sections"]:
            require(f"L{s['source_start_line']}–L{s['source_end_line']}" in md, "Source range omitted in Markdown")
        return "53 sections and 15 rules represented in readable and machine forms"
    check("readable_and_machine_source_maps_agree", mapping_markdown)

    def questions_complete():
        text = (ROOT/"06-INTEGRATION-REVIEW.md").read_text()
        nums = re.findall(r"(?m)^\| (\d+)\. ", text)
        require(nums == [str(i) for i in range(1,13)], "Review answers incomplete")
        return {"review_questions_answered": len(nums)}
    check("all_12_source_review_questions_addressed", questions_complete)

    def adrs():
        found = re.findall(r"(?m)^## (ADR-050-\d{2})",(ROOT/"02-ARCHITECTURE-DECISIONS.md").read_text())
        require(found == [f"ADR-050-{i:02d}" for i in range(1,21)], "ADR numbers wrong")
        return {"adrs": len(found)}
    check("adr_numbering_01_through_20", adrs)

    def failures():
        found = re.findall(r"(?m)^\| (FM-\d{2}) \|",(ROOT/"07-CONTRACTS-AND-FAILURE-MATRIX.md").read_text())
        require(found == [f"FM-{i:02d}" for i in range(1,23)], "Failure matrix incomplete")
        return {"failure_windows": len(found)}
    check("failure_matrix_01_through_22", failures)

    markdowns = sorted(ROOT.glob("*.md"))
    def fences():
        for path in markdowns:
            count = len(re.findall(r"(?m)^```",path.read_text()))
            require(count % 2 == 0, f"Unclosed fenced block: {path.name}")
        return {"markdown_files": len(markdowns)}
    check("markdown_fences_balanced", fences)

    def links():
        checked = 0
        for path in markdowns:
            text = no_code(path.read_text())
            urls = re.findall(r"\[[^\]\n]+\]\(([^\s)]+)\)",text)
            urls += re.findall(r"(?m)^\[[^\]]+\]:\s*(\S+)",text)
            for url in urls:
                parts = urlsplit(url)
                if parts.scheme or parts.netloc: continue
                target = (path.parent / unquote(parts.path)).resolve() if parts.path else path
                require(target.is_relative_to(ROOT), f"Escaping local link: {path.name} {url}")
                # The report is produced at the end of this same validation run.
                require(target.is_file() or target == ROOT/"document-validation.json", f"Missing link target: {path.name} {url}")
                if parts.fragment and target.suffix == '.md':
                    require(unquote(parts.fragment) in heading_anchors(target.read_text()), f"Missing anchor: {path.name} {url}")
                checked += 1
        return {"local_links_checked": checked, "network_links_fetched": 0}
    check("local_links_and_explicit_anchors_resolve", links)

    def evidence_refs():
        n = 0
        for path in markdowns:
            text = no_code(path.read_text())
            definitions = set(re.findall(r"(?m)^\[((?:E|B)\d+|S-ADD)\]:",text))
            used = set(re.findall(r"\[((?:E|B)\d+|S-ADD)\](?!:)",text))
            require(used.issubset(definitions), f"Undefined references in {path.name}: {used-definitions}")
            n += len(used)
        return {"resolved_source_references": n}
    check("local_source_reference_labels_defined", evidence_refs)

    def text_hygiene():
        for path in markdowns:
            text=path.read_text()
            require('\x00' not in text and '\ufffd' not in text, f"Invalid text: {path.name}")
            require(not re.search(r"(?m)^(<<<<<<<|=======|>>>>>>>)",text), f"Merge conflict markers: {path.name}")
            require(not re.search(r"\b(TBD|TODO|FIXME)\b", no_code(text)), f"Unresolved drafting placeholder: {path.name}")
        return "UTF-8 text, no conflict markers or unresolved drafting placeholders"
    check("document_text_hygiene", text_hygiene)

    def scope_markers():
        main_text=(ROOT/'01-DESIGN.md').read_text()
        contract=(ROOT/'07-CONTRACTS-AND-FAILURE-MATRIX.md').read_text()
        for token in ('outbox_jobs','CredentialCipher','R2ArchiveStore','R2BlobStore','JobQueue','current_job_id','DLQ','errorAmbiguous','0.5.0-rc.1'):
            present = token in main_text and (token in contract or token == "0.5.0-rc.1")
            require(present, f"Missing scope marker {token}")
        require('不修改源码' in main_text and 'NOT_RUN' in contract, "Completion boundary missing")
        return "Expected integrated topics and non-implementation boundary present; semantic correctness not executed"
    check("integration_scope_and_completion_boundaries_present", scope_markers)

    def checksum_manifest():
        expected={}
        for line in (ROOT/'SHA256SUMS.txt').read_text().splitlines():
            if not line or line.startswith('#'):continue
            digest, name = line.split('  ',1)
            require(re.fullmatch(r'[0-9a-f]{64}',digest) is not None, "Invalid checksum")
            expected[name]=digest
        actual={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in ROOT.rglob('*') if p.is_file() and p.name not in ('SHA256SUMS.txt','document-validation.json') and '__pycache__' not in p.parts}
        require(expected==actual, f"Payload checksum mismatch/missing: {sorted(set(expected)^set(actual))}")
        return {"hashed_payloads":len(actual),"excluded":["SHA256SUMS.txt","document-validation.json"]}
    check("payload_sha256_manifest_matches", checksum_manifest)

    if args.zip_path:
        def zip_check():
            with zipfile.ZipFile(args.zip_path) as zf:
                require(zf.testzip() is None, "ZIP CRC error")
                listed={n for n in zf.namelist() if not n.endswith('/')}
                root_names={n.split('/')[0] for n in listed}
                require(len(root_names)==1, "ZIP must contain one package root")
                prefix=next(iter(root_names))+'/'
                expected={prefix+p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*') if p.is_file() and '__pycache__' not in p.parts}
                require(listed==expected, "ZIP entries differ from directory")
                for name in listed:
                    require('..' not in Path(name).parts and not name.startswith('/'), "Unsafe zip path")
                    if name.endswith('/document-validation.json'):
                        # Report is rewritten with this ZIP result; validate its scope, not recursive bytes.
                        r=json.loads(zf.read(name))
                        require(r.get('product_tests_executed') is False, "ZIP report must not claim product tests")
                    else:
                        require(zf.read(name)==(ROOT/name[len(prefix):]).read_bytes(), f"ZIP byte mismatch: {name}")
            return {"file":str(args.zip_path),"entries":len(listed),"crc":"ok","payload_bytes":"match"}
        check("zip_crc_paths_and_payload_bytes", zip_check)

    report={"schema_version":1,"document_version":"2.0","checked_at":datetime.now(timezone.utc).isoformat(),
        "kind":"document_package_integrity_only","product_tests_executed":False,
        "repository_observed_this_revision":False,"implementation_status":"not_started",
        "product_acceptance":{"total":len(items),"not_run":len(items)},
        "summary":{"checks":len(CHECKS),"passed":sum(c['status']=='PASS' for c in CHECKS),"failed":sum(c['status']=='FAIL' for c in CHECKS)},
        "checks":CHECKS,
        "limitations":["Does not compile or execute Syndroo product code.","Does not prove transaction, crypto, OAuth or concurrent behavior; all product acceptance remains NOT_RUN.","Remote links and current account/runtime configuration are not fetched by this script.","Manual design review is separate from these deterministic checks.","The report is excluded from recursive payload checksums."]}
    (ROOT/'document-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report['summary'],ensure_ascii=False))
    for c in CHECKS:
        if c['status']=='FAIL': print(c['name'],c['evidence'],file=sys.stderr)
    return 0 if not report['summary']['failed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
