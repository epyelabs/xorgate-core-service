"""Entrypoint for the Fargate CV runner.

Flow: read env -> download the manifest from S3 -> run the workflow graph over the
recorded MP4 -> ALWAYS upload result.json back to S3 (even on exception/timeout).

Hard rules:
  - result.json is written on EVERY exit path (success, node failure, unhandled
    exception, and maxRuntimeSeconds timeout). A run that finished without a
    result.json would strand as "running" forever, so we exit 0 after a
    successful upload regardless of run status.
  - The process holds no DB and no API creds; all it can do is read S3 (manifest,
    MP4) and write S3 (result.json, clips).
"""

from __future__ import annotations

import os
import signal
import sys
import tempfile
from typing import Optional

from app.graph import RunContext, RunState, RunTimeout, execute
from app.manifest import Manifest, S3Store
from app.result import build_result


def _log(msg: str) -> None:
    print(f"[cv-runner] {msg}", flush=True)


def _install_watchdog(seconds: int) -> None:
    """SIGALRM watchdog: on timeout, raise RunTimeout in the main thread so the
    partially-built result is still finalized and uploaded. SIGALRM fires between
    Python bytecodes / on syscall return, which is good enough for our decode +
    inference loop (frames are processed one at a time)."""

    def _on_alarm(signum, frame):  # noqa: ARG001
        raise RunTimeout(f"exceeded maxRuntimeSeconds ({seconds}s)")

    signal.signal(signal.SIGALRM, _on_alarm)
    signal.alarm(max(1, seconds))


def _fallback_result_target(bucket: str, key: str) -> tuple[str, str]:
    """When the manifest can't be read we still must land a result.json. Derive
    it from MANIFEST_KEY (.../manifest.json -> .../result.json) in the same
    bucket, matching the workflows/v1/runs/<runId>/ layout."""
    if key.endswith("manifest.json"):
        result_key = key[: -len("manifest.json")] + "result.json"
    else:
        parent = key.rsplit("/", 1)[0] if "/" in key else ""
        result_key = (parent + "/result.json") if parent else "result.json"
    return bucket, result_key


def main() -> int:
    run_id = os.environ.get("RUN_ID", "")
    region = os.environ.get("AWS_REGION")
    manifest_bucket = os.environ.get("MANIFEST_BUCKET", "")
    manifest_key = os.environ.get("MANIFEST_KEY", "")

    _log(f"start run_id={run_id} manifest=s3://{manifest_bucket}/{manifest_key}")

    s3 = S3Store(region)
    state = RunState()
    manifest: Optional[Manifest] = None

    try:
        raw = s3.download_json(manifest_bucket, manifest_key)
        manifest = Manifest.from_dict(raw)
        run_id = manifest.run_id or run_id

        _install_watchdog(manifest.limits.max_runtime_seconds)
        with tempfile.TemporaryDirectory(prefix="cv-runner-") as tmp_dir:
            ctx = RunContext(
                run_id=run_id,
                manifest=manifest,
                s3=s3,
                metrics=state.metrics,  # shared dict; executors accumulate into it
                tmp_dir=tmp_dir,
            )
            execute(ctx, state)
    except RunTimeout as e:
        _log(f"timeout: {e}")
        state.status = "failed"
        state.failed_error = "timeout"
        state.failed_node_id = state.failed_node_id or state.current_node_id
        if state.current_node_id and not state.has_step(state.current_node_id):
            label = state.current_node_id
            if manifest:
                node = next((n for n in manifest.definition.nodes if n.id == state.current_node_id), None)
                if node:
                    label = node.label
            state.add_step(state.current_node_id, label, "failed", "timeout", 0)
    except Exception as e:  # noqa: BLE001 — must still emit a result.json
        _log(f"unhandled error: {e!r}")
        state.status = "failed"
        state.failed_error = str(e) or e.__class__.__name__
        state.failed_node_id = state.failed_node_id or state.current_node_id
    finally:
        signal.alarm(0)  # disarm the watchdog before we do the (S3) upload

    # Resolve where result.json goes, then ALWAYS upload it.
    if manifest and manifest.output.bucket and manifest.output.result_key:
        out_bucket, out_key = manifest.output.bucket, manifest.output.result_key
    else:
        out_bucket, out_key = _fallback_result_target(manifest_bucket, manifest_key)

    result = build_result(run_id, state)
    _log(f"result status={result['status']} steps={len(result['steps'])} "
         f"events={len(result['events'])} -> s3://{out_bucket}/{out_key}")

    try:
        s3.upload_json(out_bucket, out_key, result)
    except Exception as e:  # noqa: BLE001
        # If we cannot persist the result, the run is stranded regardless — surface
        # a nonzero exit so the failure is visible in the task logs.
        _log(f"FATAL: failed to upload result.json: {e!r}")
        return 1

    _log("result.json uploaded; exiting 0")
    return 0


if __name__ == "__main__":
    # Exit 0 even on run failure (result.json carries the failed status); only a
    # failed upload yields nonzero.
    sys.exit(main())
